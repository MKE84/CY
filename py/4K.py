# coding=utf-8
"""
目标站: 4kvm  首页: https://www.4kvm.net
动态筛选、精准分集、去重列表

优化要点（速度优先，稳定次之）：
1. 首页与三个筛选页并发抓取，首屏不再被串行筛选请求拖慢
2. 内存 TTL 缓存（首页/分类/搜索/详情 HTML）+ 筛选结果磁盘缓存（跨重启生效）
3. 优先 lxml 解析器（比 html.parser 快数倍），不可用时自动回退
4. 所有请求统一超时，慢请求不拖垮列表加载；失败自动降级返回空结果
"""
import re
import os
import sys
import json
import time
import tempfile
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from bs4 import BeautifulSoup

sys.path.append('..')
from base.spider import Spider


def _pick_parser():
    """lxml 解析远快于内置 html.parser，优先使用；缺失时回退"""
    try:
        import lxml  # noqa
        return 'lxml'
    except Exception:
        return 'html.parser'


_PARSER = _pick_parser()


class _TTLCache(object):
    """极简内存 TTL 缓存（线程安全依赖 GIL 字典操作）"""

    def __init__(self, ttl=300):
        self._ttl = ttl
        self._data = {}

    def get(self, key):
        item = self._data.get(key)
        if not item:
            return None
        exp, val = item
        if exp < time.time():
            self._data.pop(key, None)
            return None
        return val

    def set(self, key, val, ttl=None):
        t = ttl or self._ttl
        self._data[key] = (time.time() + t, val)

    def clear(self):
        self._data.clear()


class Spider(Spider):

    def init(self, extend=""):
        self.site_url = "https://www.4kvm.top"
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': self.site_url,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
        # 2026-09 加固: 双域名自动探测 (4kvm.net / 4kvm.top)
        try:
            import requests as _rq
            for cand in ("https://www.4kvm.net", "https://www.4kvm.top"):
                try:
                    _r = requests.get(cand + "/", timeout=8,
                                      headers={'User-Agent': self.headers['User-Agent'], 'Referer': cand + '/'})
                    if _r.status_code == 200 and '4k' in _r.text[:2000]:
                        self.site_url = cand
                        self.headers['Referer'] = cand
                        break
                except Exception:
                    continue
        except Exception:
            pass
        self.categories = [
            {"type_id": "1", "type_name": "电影"},
            {"type_id": "2", "type_name": "电视剧"},
            {"type_id": "3", "type_name": "动漫"}
        ]
        # 多次 init 时不重置已建立的缓存，避免重复抓取
        if not hasattr(self, '_filters_cache'):
            self._filters_cache = None
        if not hasattr(self, '_html_cache'):
            self._html_cache = _TTLCache(ttl=300)   # 首页/列表/搜索页 5 分钟
        self._filters_disk = os.path.join(tempfile.gettempdir(), "4kvm_filters_cache.json")

    # ================= 基础抓取（缓存 + 超时 + 状态码校验） =================
    def _fetch(self, url, cache_ttl=0, timeout=8000):
        """抓取 HTML 文本；cache_ttl>0 时按 TTL 缓存，返回 None 表示失败"""
        if cache_ttl > 0:
            hit = self._html_cache.get(url)
            if hit is not None:
                return hit
        try:
            resp = self.fetch(url, headers=self.headers, timeout=timeout)
        except TypeError:
            # 老版本 base 不支持 timeout 参数时的兼容
            resp = self.fetch(url, headers=self.headers)
        except Exception:
            resp = None
        if resp is None:
            return None
        try:
            if getattr(resp, 'status_code', 200) != 200:
                return None
            text = resp.text if hasattr(resp, 'text') else str(resp)
        except Exception:
            return None
        if not text:
            return None
        if cache_ttl > 0:
            self._html_cache.set(url, text, ttl=cache_ttl)
        return text

    # ================= 动态筛选解析 =================
    def _fetch_filters_for_classify(self, tid):
        """请求 /filter?classify=tid，解析页面筛选区域，返回该分类的筛选列表"""
        url = f"{self.site_url}/filter?classify={tid}"
        html = self._fetch(url, cache_ttl=1800)   # 筛选页缓存 30 分钟
        if not html:
            return []
        soup = BeautifulSoup(html, _PARSER)
        filter_groups = []
        containers = soup.select('main div.flex.flex-wrap.items-center.gap-3')
        for container in containers:
            links = container.select('a[href]')
            if len(links) < 2:
                continue
            first_text = links[0].get_text(strip=True)
            if not first_text.startswith('全部'):
                continue
            group_name = first_text.replace('全部', '', 1).strip()
            # 从非全部的链接中提取参数键
            param_key = None
            for a in links[1:]:
                href = a.get('href', '')
                parsed = urllib.parse.urlparse(href)
                qs = urllib.parse.parse_qs(parsed.query)
                for k in qs:
                    if k not in ('classify', 'page'):
                        param_key = k
                        break
                if param_key:
                    break
            if not param_key:
                continue
            if param_key in ('sort_by', 'order'):
                continue
            options = []
            for a in links:
                text = a.get_text(strip=True)
                href = a.get('href', '')
                parsed = urllib.parse.urlparse(href)
                qs = urllib.parse.parse_qs(parsed.query)
                val = ''
                if param_key in qs:
                    val = qs[param_key][0] if qs[param_key] else ''
                if text.startswith('全部'):
                    val = ''
                options.append({"n": text, "v": val})
            if options:
                filter_groups.append({
                    "key": param_key,
                    "name": group_name,
                    "value": options
                })
        return filter_groups

    def _load_filters_disk(self):
        try:
            if not os.path.exists(self._filters_disk):
                return None
            with open(self._filters_disk, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and data.get('_t', 0) > time.time() - 24 * 3600:
                return data.get('filters') or None
        except Exception:
            pass
        return None

    def _save_filters_disk(self, filters):
        try:
            with open(self._filters_disk, 'w', encoding='utf-8') as f:
                json.dump({'_t': time.time(), 'filters': filters}, f, ensure_ascii=False)
        except Exception:
            pass

    def _get_all_filters(self):
        if self._filters_cache is not None:
            return self._filters_cache
        disk = self._load_filters_disk()
        if disk:
            self._filters_cache = disk
            return disk
        filters = {}
        # 三个分类的筛选页并发抓取（串行 → 并行，首次加载约提速 3 倍）
        with ThreadPoolExecutor(max_workers=3) as ex:
            futs = {ex.submit(self._fetch_filters_for_classify, tid): tid for tid in ("1", "2", "3")}
            for fut in as_completed(futs):
                tid = futs[fut]
                try:
                    groups = fut.result() or []
                except Exception:
                    groups = []
                if groups:
                    filters[tid] = groups
        # 为没有筛选的分类复用电影分类的筛选
        if "1" in filters:
            filters.setdefault("3", filters["1"])
            filters.setdefault("4", filters["1"])
        if filters:
            self._save_filters_disk(filters)
        self._filters_cache = filters
        return filters

    # ================= 列表解析公共方法 =================
    def _parse_cards(self, html, limit=None):
        video_list = []
        soup = BeautifulSoup(html, _PARSER)
        cards = soup.select('div[data-vod-id]')
        if limit:
            cards = cards[:limit]
        for card in cards:
            a = card.select_one('a.block[href^="/play/"]')
            if not a:
                continue
            vod_id = (card.get('data-vod-id') or '').strip()
            if not vod_id:
                vod_id = a.get('href', '').replace('/play/', '').strip()
            if not vod_id:
                continue
            title_tag = card.select_one('h3.text-white') or card.select_one('h3')
            vod_name = title_tag.get_text(strip=True) if title_tag else ''
            if not vod_name:
                continue
            img = card.select_one('img[data-src]')
            vod_pic = ''
            if img:
                src = img.get('data-src', '') or ''
                if src and not src.startswith('data:'):
                    vod_pic = src if src.startswith('http') else 'https:' + src
            remark_tag = card.select_one('.text-green-500, .text-yellow-400, span[class*="px-1.5"]')
            vod_remarks = remark_tag.get_text(strip=True) if remark_tag else ''
            video_list.append({
                "vod_id": vod_id,
                "vod_name": vod_name,
                "vod_pic": vod_pic,
                "vod_remarks": vod_remarks
            })
        return video_list

    # ================= 核心业务方法 =================
    def homeContent(self, filter):
        # 首页与筛选页并发抓取：筛选结果不阻塞首屏
        pool = ThreadPoolExecutor(max_workers=4)
        try:
            filters_fut = pool.submit(self._get_all_filters)
            home_fut = pool.submit(self._fetch, self.site_url + "/", 300, 8000)
            html = None
            try:
                html = home_fut.result(timeout=8)
            except Exception:
                html = None
            video_list = self._parse_cards(html, limit=20) if html else []
            filters = {}
            try:
                filters = filters_fut.result(timeout=8)
            except Exception:
                # 未取到则回退到缓存（内存/磁盘），不再额外发起请求
                filters = self._filters_cache or {}
        finally:
            pool.shutdown(wait=False)
        return {"class": self.categories, "list": video_list, "filters": filters}

    def homeVideoContent(self):
        return self.homeContent(False)

    def categoryContent(self, tid, pg, filter, extend):
        page = int(pg) if pg else 1
        params = {"classify": tid}
        if extend:
            for k, v in extend.items():
                if v and k != 'classify':
                    params[k] = v
        if page > 1:
            params['page'] = page
        query = urllib.parse.urlencode(params)
        url = f"{self.site_url}/filter?{query}"

        html = self._fetch(url, cache_ttl=300)
        if not html:
            return {"list": [], "page": page, "pagecount": 1, "limit": 24, "total": 0}

        video_list = self._parse_cards(html)

        # 分页处理
        pagecount = page
        soup = BeautifulSoup(html, _PARSER)
        page_text = soup.find(string=re.compile(r'共\s*\d+\s*页'))
        if page_text:
            nums = re.findall(r'\d+', page_text)
            if nums:
                pagecount = int(nums[-1])
        else:
            page_block = soup.select_one('.flex.justify-center')
            if page_block:
                page_links = page_block.select('a[href*="page="]')
                for a in page_links:
                    text = a.get_text(strip=True)
                    if text.isdigit():
                        pagecount = max(pagecount, int(text))

        return {
            "list": video_list,
            "page": page,
            "pagecount": pagecount,
            "limit": 24,
            "total": len(video_list) * pagecount
        }

    def detailContent(self, ids):
        if not ids:
            return {"list": []}
        vod_id = ids[0]
        url = f"{self.site_url}/play/{vod_id}"
        html = self._fetch(url, cache_ttl=600, timeout=10000)
        if not html:
            return {"list": []}

        soup = BeautifulSoup(html, _PARSER)

        # 标题
        title_elem = soup.select_one('h1.text-xl') or soup.select_one('h1') or soup.select_one('h2')
        vod_name = title_elem.get_text(strip=True) if title_elem else vod_id

        # 图片（优先 alt 与片名一致的封面，其次带 src 的 w-full 图，跳过无 src 占位图）
        vod_pic = ''
        img_elem = None
        for cand in soup.select('img.w-full[src]'):
            if cand.get('alt', '').strip() == vod_name:
                img_elem = cand
                break
        if img_elem is None:
            img_elem = soup.select_one('img.w-full[src]')
        if img_elem is None:
            img_elem = soup.select_one('img[src]')
        if img_elem:
            src = img_elem.get('src', '') or img_elem.get('data-src', '')
            if src and not src.startswith('data:'):
                vod_pic = src if src.startswith('http') else 'https:' + src

        # 导演、主演、简介
        vod_director = ''
        vod_actor = ''
        vod_content = ''
        info_block = soup.select_one('.rounded-lg div.grid') or soup.select_one('div.grid')
        if info_block:
            text = info_block.get_text(' ', strip=True)
            dir_match = re.search(r'导演\s*([^主\n]+)', text)
            if dir_match:
                vod_director = dir_match.group(1).strip()
            act_match = re.search(r'主演\s*([^剧\n]+)', text)
            if act_match:
                vod_actor = act_match.group(1).strip()
            desc_match = re.search(r'剧情简介\s*(.+)', text, re.DOTALL)
            if desc_match:
                vod_content = desc_match.group(1).strip()
            elif re.search(r'简介\s*(.+)', text, re.DOTALL):
                vod_content = re.search(r'简介\s*(.+)', text, re.DOTALL).group(1).strip()

        # ================= 分集解析 (基于 episodeManager) =================
        play_from_list = []
        play_url_list = []

        episode_manager = soup.select_one('[x-data*="episodeManager"]')
        if episode_manager:
            xdata = episode_manager.get('x-data', '')
            lines_raw = re.findall(r'\{[^}]*lineName\s*:\s*\'([^\']+)\'[^}]*episodeCount\s*:\s*(\d+)[^}]*\}', xdata)
            lines_info = [{'lineName': name, 'episodeCount': int(count)} for name, count in lines_raw]

            episode_links = episode_manager.select('a[data-episode]')
            lines_eps = {}
            for a in episode_links:
                line = a.get('data-line', '1')
                ep = a.get('data-episode', '')
                href = a.get('href', '')
                if not href or not ep:
                    continue
                full_url = href if href.startswith('http') else self.site_url + href
                lines_eps.setdefault(line, []).append((int(ep), full_url))

            # 按顺序给各线路分配线路名，修复原先所有线路共用第一个线路名的问题
            line_names = [info['lineName'] for info in lines_info] if lines_info else []
            for idx, line_key in enumerate(sorted(lines_eps.keys())):
                eps = sorted(lines_eps[line_key], key=lambda x: x[0])
                line_name = line_names[idx] if idx < len(line_names) else f'线路{line_key}'
                if not eps:
                    continue
                episode_strs = [f"第{ep[0]}集${ep[1]}" for ep in eps]
                play_from_list.append(line_name)
                play_url_list.append('#'.join(episode_strs))

        # 回退：无分集则直接播放当前页
        if not play_url_list:
            play_from_list.append('播放')
            play_url_list.append(f"播放${vod_id}")

        vod_play_from = '$$$'.join(play_from_list)
        vod_play_url = '$$$'.join(play_url_list)

        result = [{
            "vod_id": vod_id,
            "vod_name": vod_name,
            "vod_pic": vod_pic,
            "vod_content": vod_content,
            "vod_actor": vod_actor,
            "vod_director": vod_director,
            "vod_area": "",
            "vod_year": "",
            "vod_play_from": vod_play_from,
            "vod_play_url": vod_play_url
        }]
        return {"list": result}

    def searchContent(self, key, quick, pg="1"):
        page = int(pg) if pg else 1
        params = {"q": key}
        if page > 1:
            params['page'] = page
        query = urllib.parse.urlencode(params)
        url = f"{self.site_url}/search?{query}"
        html = self._fetch(url, cache_ttl=120)
        if not html:
            return {"list": [], "page": page, "pagecount": 1}

        video_list = self._parse_cards(html)
        if not video_list:
            # 搜索页可能没有 data-vod-id，降级处理
            soup = BeautifulSoup(html, _PARSER)
            for a in soup.select('a.block[href^="/play/"]'):
                href = a.get('href', '')
                vod_id = href.replace('/play/', '').strip()
                if not vod_id:
                    continue
                h3 = a.select_one('h3')
                vod_name = h3.get_text(strip=True) if h3 else href
                if not vod_name:
                    continue
                img = a.select_one('img[data-src]')
                vod_pic = ''
                if img:
                    src = img.get('data-src', '')
                    if src and not src.startswith('data:'):
                        vod_pic = src if src.startswith('http') else 'https:' + src
                video_list.append({
                    "vod_id": vod_id,
                    "vod_name": vod_name,
                    "vod_pic": vod_pic,
                    "vod_remarks": ''
                })
        else:
            video_list = video_list[:30]
        return {"list": video_list, "page": page, "pagecount": 1}

    def playerContent(self, flag, id, vipFlags):
        if not id.startswith('http'):
            url = f"{self.site_url}/play/{id}"
        else:
            url = id
        return {"parse": 1, "url": url, "header": self.headers}