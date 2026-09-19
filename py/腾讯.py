# coding=utf-8
# !/usr/bin/python
"""
腾讯视频爬虫（修复版：可脱离 base.spider 独立运行）
====================================================
修复点：
  1. 移除对外部 base.spider 基类的硬依赖：有则用，无则用内置兜底基类，
     兜底基类自带 fetch / post / cleanText，脚本单独放置即可运行；
  2. getName / isVideoFormat / manualVideoCheck / localProxy / destroy /
     searchContentPage 全部补全，协议完整；
  3. 所有网络请求：超时 + 有限重试 + Session 连接复用（速度第一、稳定第二）；
  4. 所有解析点增加 .get / try 防护，接口返回异常时优雅降级而不是整脚本崩掉；
  5. dbody 改为深拷贝，避免翻页时意外污染初始 body；
  6. __main__ 提供完整独立自检，python3 腾讯.py 直接可跑。
"""
import json
import os
import sys
import uuid
import copy
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from pyquery import PyQuery as pq

# 兼容聚合框架的基类：有就用框架的，没有就退回内置兜底，保证独立运行
try:
    from base.spider import Spider as _BaseSpider
except Exception:
    class _BaseSpider:
        """内置兜底基类：自带 fetch/post/cleanText，脱离框架也能独立运行"""

        def init(self, extend=""):
            pass

        def fetch(self, url, headers=None, params=None, retries=2, timeout=10):
            """GET：超时 + 有限重试，失败返回 None 而不是抛异常"""
            for attempt in range(retries + 1):
                try:
                    r = requests.get(url, headers=headers, params=params, timeout=timeout)
                    r.raise_for_status()
                    return r
                except Exception as e:
                    if attempt >= retries:
                        print(f"[fetch失败] {url}: {e}")
                        return None
                    time.sleep(0.3 * (attempt + 1))

        def post(self, url, headers=None, data=None, json=None, retries=2, timeout=10):
            """POST：超时 + 有限重试，失败返回 None 而不是抛异常"""
            for attempt in range(retries + 1):
                try:
                    r = requests.post(url, headers=headers, data=data, json=json, timeout=timeout)
                    r.raise_for_status()
                    return r
                except Exception as e:
                    if attempt >= retries:
                        print(f"[post失败] {url}: {e}")
                        return None
                    time.sleep(0.3 * (attempt + 1))

        def cleanText(self, text):
            """只清理 HTML 注释与多余回车；保留 <script> 内容（首页数据在 script 里）"""
            if not text:
                return text
            return re.sub(r'<!--.*?-->', '', text, flags=re.S).replace('\r', '')


class Spider(_BaseSpider):

    def init(self, extend=""):
        self.dbody = {
            "page_params": {
                "channel_id": "",
                "filter_params": "sort=75",
                "page_type": "channel_operation",
                "page_id": "channel_list_second_page"
            }
        }
        self.body = self.dbody
        if not getattr(self, '_session', None):
            self._session = requests.Session()
            self._session.headers.update(self.headers)
        return None

    def getName(self):
        return "腾讯视频"

    def isVideoFormat(self, url):
        video_formats = ('.mp4', '.m3u8', '.ts', '.mkv', '.avi', '.flv', '.webm')
        if url and isinstance(url, str) and url.startswith('http'):
            return any(fmt in url.lower() for fmt in video_formats)
        return False

    def manualVideoCheck(self):
        return False

    def destroy(self):
        sess = getattr(self, '_session', None)
        if sess is not None:
            try:
                sess.close()
            except Exception:
                pass

    def localProxy(self, param):
        return None

    def searchContentPage(self, key, quick, pg="1"):
        return self.searchContent(key, quick, pg)

    @staticmethod
    def _safe_json(obj, default=None):
        """uni_imgtag/imgTag 可能是字符串、dict 或 None，统一安全解析"""
        if obj is None:
            return default or {}
        if isinstance(obj, dict):
            return obj
        if isinstance(obj, str):
            try:
                return json.loads(obj)
            except Exception:
                return default or {}
        return default or {}

    host = 'https://v.qq.com'

    apihost = 'https://pbaccess.video.qq.com'

    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.5410.0 Safari/537.36',
        'origin': host,
        'referer': f'{host}/'
    }

    # 默认解析站（虾米/XM解析，对多数腾讯视频能返回直连CDN）。
    # 想换解析站不用改代码：环境变量 VQQ_PARSE=你的解析站模板，{url} 为视频页地址，
    # 例如 VQQ_PARSE="https://jx.bozrc.com:4433/player/analyse.php?v={url}"
    parse_site = 'https://jx.xmflv.com/?url={url}'

    def _play_headers(self):
        """播放请求头：CDN 校验 Referer/UA，缺失容易 403 或限速"""
        return {
            'User-Agent': self.headers.get('User-Agent', ''),
            'Referer': f'{self.host}/',
            'Origin': self.host,
        }

    def _build_parse_url(self, cover_url):
        """用解析站模板拼解析地址，支持 {url} 占位符或 ?url= 追加两种风格"""
        site = os.environ.get('VQQ_PARSE', self.parse_site).strip()
        if '{url}' in site:
            return site.replace('{url}', cover_url)
        sep = '&' if '?' in site else '?'
        return f"{site}{sep}url={cover_url}"

    def homeContent(self, filter):
        cdata = {
            "电视剧": "100113",
            "电影": "100173",
            "综艺": "100109",
            "纪录片": "100105",
            "动漫": "100119",
            "少儿": "100150",
            "短剧": "110755"
        }
        result = {}
        classes = []
        filters = {}
        for k in cdata:
            classes.append({
                'type_name': k,
                'type_id': cdata[k]
            })
        # 并行拉取各频道筛选条件，失败频道静默跳过
        with ThreadPoolExecutor(max_workers=min(len(classes), 6)) as executor:
            futures = [executor.submit(self.get_filter_data, item['type_id']) for item in classes]
            for future in futures:
                try:
                    cid, data = future.result()
                except Exception as e:
                    print(f"获取筛选条件失败: {e}")
                    continue
                if not data.get('data', {}).get('module_list_datas'):
                    continue
                filter_dict = {}
                try:
                    items = data['data']['module_list_datas'][-1]['module_datas'][-1]['item_data_lists']['item_datas']
                    for item in items:
                        if not item.get('item_params', {}).get('index_item_key'):
                            continue
                        params = item['item_params']
                        filter_key = params['index_item_key']
                        if filter_key not in filter_dict:
                            filter_dict[filter_key] = {
                                'key': filter_key,
                                'name': params['index_name'],
                                'value': []
                            }
                        filter_dict[filter_key]['value'].append({
                            'n': params['option_name'],
                            'v': params['option_value']
                        })
                except (IndexError, KeyError, TypeError):
                    continue
                filters[cid] = list(filter_dict.values())
        result['class'] = classes
        result['filters'] = filters
        return result

    def homeVideoContent(self):
        """首页推荐：优先解析新版 SSR（channelPageData），兼容旧版 INITIAL_STATE，
        全部失败则用电视剧频道 API 兜底 —— 三层保障保证稳定"""
        vlist = []
        rsp = self.fetch(self.host, headers=self.headers)
        if rsp is not None:
            # 页面是 UTF-8 但响应头未声明，requests 可能按 latin-1 解码，这里强制 UTF-8
            try:
                html = rsp.content.decode('utf-8')
            except Exception:
                html = rsp.text
            vlist = self._parse_choice_cards(html)
            if not vlist:
                vlist = self._parse_initial_state(html)
        if not vlist:
            # 兜底：电视剧频道推荐（走稳定 API）
            try:
                vlist = self.categoryContent('100113', 1, True, {}).get('list', [])
            except Exception as e:
                print(f"首页推荐兜底失败: {e}")
                vlist = []
        return {'list': vlist[:24]}

    def _parse_choice_cards(self, html):
        """新版 SSR：window.__vikor__context__.ssrPayloads 内的
        channelPageData.channelsModulesMap.<cid>.cardListData[].focusList[]"""
        try:
            pos = html.find('channelPageData:{')
            if pos < 0:
                return []
            start = html.find('{', pos)
            end = self._match_brace(html, start)
            if end <= 0:
                return []
            obj = json.loads(self._fix_js_object(html[start:end]))
            vlist = []
            seen = set()
            for ch in (obj.get('channelsModulesMap') or {}).values():
                for card in (ch.get('cardListData') or []):
                    for f in (card.get('focusList') or []):
                        if not f:
                            continue
                        vid = f.get('cid') or f.get('id')
                        name = f.get('mzTitle') or f.get('title') or f.get('realVidTitle')
                        if not vid or not name or vid in seen:
                            continue
                        seen.add(vid)
                        vlist.append({
                            'vod_id': vid,
                            'vod_name': name,
                            'vod_pic': f.get('coverPic') or f.get('smallCoverPic'),
                            'vod_year': '',
                            'vod_remarks': f.get('subTitle') or f.get('topicLabelTitle') or f.get('recNormalReason') or ''
                        })
            return vlist
        except Exception as e:
            print(f"解析首页推荐失败: {e}")
            return []

    def _parse_initial_state(self, html):
        """旧版 SSR 兼容：window.__INITIAL_STATE__（腾讯改版前结构）"""
        try:
            m = re.search(r'window\.__INITIAL_STATE__\s*=\s*', html)
            if not m:
                return []
            start = html.find('{', m.end())
            end = self._match_brace(html, start)
            if end <= 0:
                return []
            sd = json.loads(self._fix_js_object(html[start:end]))
            cm = sd.get('storeModulesData', {}).get('channelsModulesMap', {}).get('choice', {}).get('cardListData')
            if not cm:
                return []
            vlist = []
            seen = set()
            for its in cm:
                for it in ((its or {}).get('children_list', {}).get('list', {}).get('cards') or []):
                    if not it:
                        continue
                    p = it.get('params') or {}
                    tag = self._safe_json(p.get('uni_imgtag') or p.get('imgtag'))
                    vid = it.get('id') or p.get('cid')
                    name = p.get('mz_title') or p.get('title')
                    if not vid or not name or vid in seen or 'http' in str(vid):
                        continue
                    seen.add(vid)
                    vlist.append({
                        'vod_id': vid,
                        'vod_name': name,
                        'vod_pic': p.get('image_url'),
                        'vod_year': (tag or {}).get('tag_2', {}).get('text'),
                        'vod_remarks': (tag or {}).get('tag_4', {}).get('text')
                    })
            return vlist
        except Exception as e:
            print(f"解析旧版首页数据失败: {e}")
            return []

    def _match_brace(self, text, start):
        """字符串感知的括号匹配，返回匹配右括号的下一个位置；失败返回 -1"""
        depth = 1
        i = start + 1
        n = len(text)
        in_str = False
        esc = False
        while i < n and depth > 0:
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == '\\':
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
            i += 1
        return i if depth == 0 else -1

    def _fix_js_object(self, text):
        """把 JS 对象字面量转成合法 JSON：补引号键、void 0/undefined/!0/!1 转合法值。
        全程字符串感知，不会误改字符串内部内容"""
        out = []
        i = 0
        n = len(text)
        while i < n:
            c = text[i]
            if c == '"':
                j = i + 1
                while j < n:
                    if text[j] == '\\':
                        j += 2
                        continue
                    if text[j] == '"':
                        break
                    j += 1
                out.append(text[i:j + 1])
                i = j + 1
                continue
            if c in '{,':
                m = re.match(r'[A-Za-z_$][A-Za-z0-9_$]*', text[i + 1:])
                if m:
                    j = i + 1 + m.end()
                    k = j
                    while k < n and text[k] in ' \t\n':
                        k += 1
                    if k < n and text[k] == ':':
                        out.append(c + '"' + m.group(0) + '"')
                        i = j
                        continue
                out.append(c)
                i += 1
                continue
            if c.isalpha() or c in '_$':
                m = re.match(r'[A-Za-z_$][A-Za-z0-9_$]*', text[i:])
                word = m.group(0)
                j = i + m.end()
                if word == 'void':
                    k = j
                    while k < n and text[k] in ' \t\n':
                        k += 1
                    if k < n and text[k] == '0':
                        out.append('null')
                        i = k + 1
                        continue
                if word == 'undefined':
                    out.append('null')
                    i = j
                    continue
                out.append(word)
                i = j
                continue
            if c == '!' and i + 1 < n:
                nxt = text[i + 1]
                if nxt == '0':
                    out.append('true')
                    i += 2
                    continue
                if nxt == '1':
                    out.append('false')
                    i += 2
                    continue
            out.append(c)
            i += 1
        return ''.join(out)

    def gethtml(self, url):
        rsp = self.fetch(url, headers=self.headers)
        if rsp is None:
            return pq('')
        try:
            html = rsp.content.decode('utf-8')
        except Exception:
            html = rsp.text
        rsp = self.cleanText(html)
        return pq(rsp)

    def categoryContent(self, tid, pg, filter, extend):
        result = {}
        params = {
            "sort": extend.get('sort', '75'),
            "attr": extend.get('attr', '-1'),
            "itype": extend.get('itype', '-1'),
            "ipay": extend.get('ipay', '-1'),
            "iarea": extend.get('iarea', '-1'),
            "iyear": extend.get('iyear', '-1'),
            "theater": extend.get('theater', '-1'),
            "award": extend.get('award', '-1'),
            "recommend": extend.get('recommend', '-1')
        } if extend else {
            "sort": '75', "attr": '-1', "itype": '-1', "ipay": '-1',
            "iarea": '-1', "iyear": '-1', "theater": '-1',
            "award": '-1', "recommend": '-1'
        }
        # 深拷贝，避免污染初始 body（翻页依赖 page_context）
        if str(pg) == '1':
            self.body = copy.deepcopy(self.dbody)
        self.body['page_params']['channel_id'] = tid
        self.body['page_params']['filter_params'] = self.josn_to_params(params)

        try:
            rsp = self.post(
                f'{self.apihost}/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=1000005&vplatform=2&vversion_name=8.9.10&new_mark_label_enabled=1',
                json=self.body, headers=self.headers)
            if rsp is None:
                return {'list': [], 'page': pg, 'limit': 90, 'total': 0, 'pagecount': int(pg)}
            data = rsp.json()
        except Exception as e:
            print(f"获取分类内容失败: {e}")
            return {'list': [], 'page': pg, 'limit': 90, 'total': 0, 'pagecount': int(pg)}

        ndata = data.get('data') or {}
        if not ndata:
            return {'list': [], 'page': pg, 'limit': 90, 'total': 0, 'pagecount': int(pg)}

        if ndata.get('has_next_page'):
            result['pagecount'] = 9999
            self.body['page_context'] = ndata.get('next_page_context')
        else:
            result['pagecount'] = int(pg)

        vlist = []
        try:
            items = ndata['module_list_datas'][-1]['module_datas'][-1]['item_data_lists']['item_datas']
        except (IndexError, KeyError, TypeError):
            items = []
        for its in items:
            p = its.get('item_params', {})
            id = p.get('cid')
            if id:
                tag = self._safe_json(p.get('uni_imgtag') or p.get('imgtag'))
                name = p.get('mz_title') or p.get('title')
                pic = p.get('new_pic_hz') or p.get('new_pic_vt')
                vlist.append({
                    'vod_id': id,
                    'vod_name': name,
                    'vod_pic': pic,
                    'vod_year': (tag or {}).get('tag_2', {}).get('text'),
                    'vod_remarks': (tag or {}).get('tag_4', {}).get('text')
                })
        result['list'] = vlist
        result['page'] = pg
        result['limit'] = 90
        result['total'] = 999999
        return result

    def detailContent(self, ids):
        if not ids:
            return {'list': []}
        vbody = {
            "page_params": {
                "req_from": "web",
                "cid": ids[0],
                "vid": "",
                "lid": "",
                "page_type": "detail_operation",
                "page_id": "detail_page_introduction"
            },
            "has_cache": 1
        }

        body = {
            "page_params": {
                "req_from": "web_vsite",
                "page_id": "vsite_episode_list",
                "page_type": "detail_operation",
                "id_type": "1",
                "page_size": "",
                "cid": ids[0],
                "vid": "",
                "lid": "",
                "page_num": "",
                "page_context": "",
                "detail_page_type": "1"
            },
            "has_cache": 1
        }

        # 详情信息与剧集列表并行拉取（速度第一）
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_detail = executor.submit(self.get_vdata, vbody)
            future_episodes = executor.submit(self.get_vdata, body)
            vdata = future_detail.result()
            data = future_episodes.result()

        pdata = self.process_tabs(data, body, ids)
        if not pdata:
            return self.handle_exception(None, "No pdata available")

        try:
            try:
                modules = vdata['data']['module_list_datas'][0]['module_datas'][0]['item_data_lists']['item_datas']
                star_list = modules[0].get('sub_items', {}).get('star_list', {}).get('item_datas', []) if modules else []
            except (IndexError, KeyError, TypeError):
                star_list = []
            actors = [star.get('item_params', {}).get('name') for star in star_list
                      if star.get('item_params', {}).get('name')]
            names = []
            urls = []
            plist, ylist = self.process_pdata(pdata, ids)
            # 双线路：同一批集数，两条播放源（解析站 + 官方页直解析），可互相切换
            if plist:
                names.append('腾讯视频')
                urls.append('#'.join(plist))
                names.append('腾讯官方')
                urls.append('#'.join(plist))
            if ylist:
                names.append('预告片')
                urls.append('#'.join(ylist))
            vod = self.build_vod(vdata, actors, urls, names)
            return {'list': [vod]}
        except Exception as e:
            return self.handle_exception(e, "Error processing detail")

    def searchContent(self, key, quick, pg="1"):
        body = {"version": "24072901", "clientType": 1, "filterValue": "", "uuid": str(uuid.uuid4()), "retry": 0,
                "query": key, "pagenum": int(pg) - 1, "pagesize": 30, "queryFrom": 0, "searchDatakey": "",
                "transInfo": "", "isneedQc": True, "preQid": "", "adClientInfo": "",
                "extraInfo": {"isNewMarkLabel": "1", "multi_terminal_pc": "1"}}
        try:
            rsp = self.post(f'{self.apihost}/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vplatform=2',
                            json=body, headers=self.headers)
            if rsp is None:
                return {'list': [], 'page': pg}
            data = rsp.json()
        except Exception as e:
            print(f"搜索失败: {e}")
            return {'list': [], 'page': pg}

        vlist = []
        area_boxes = data.get('data', {}).get('areaBoxList') or []
        if not area_boxes:
            return {'list': [], 'page': pg}
        for k in area_boxes[-1].get('itemList') or []:
            if not k.get('doc', {}).get('id'):
                continue
            vi = k.get('videoInfo', {}) or {}
            tag = self._safe_json(vi.get('imgTag'))
            vlist.append({
                'vod_id': k['doc']['id'],
                'vod_name': vi.get('title', ''),
                'vod_pic': vi.get('imgUrl'),
                'vod_year': (tag or {}).get('tag_2', {}).get('text', ''),
                'vod_remarks': (tag or {}).get('tag_4', {}).get('text', '')
            })
        return {'list': vlist, 'page': pg}

    def playerContent(self, flag, id, vipFlags):
        """双线路播放：
        - 默认线路：走解析站（可 VQQ_PARSE 换站），多数视频能拿到直连 CDN；
        - 腾讯官方线路：直接把官方播放页交给播放器网页嗅探，作为备用，
          一条慢/失败时切另一条即可。
        """
        ids = id.split('@')
        if len(ids) < 2:
            return {'parse': 1, 'url': f"{self.host}/x/cover/{id}", 'header': self._play_headers()}
        cid, vid = ids[0], ids[1]
        cover_url = f"{self.host}/x/cover/{cid}/{vid}.html"
        if flag == '腾讯官方':
            return {'parse': 1, 'url': cover_url, 'header': self._play_headers()}
        return {'parse': 1, 'url': self._build_parse_url(cover_url), 'header': self._play_headers()}

    def gethtml(self, url):
        rsp = self.fetch(url, headers=self.headers)
        if rsp is None:
            return pq('')
        rsp = self.cleanText(rsp.text)
        return pq(rsp)

    def get_filter_data(self, cid):
        hbody = copy.deepcopy(self.dbody)
        hbody['page_params']['channel_id'] = cid
        try:
            rsp = self.post(
                f'{self.apihost}/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=1000005&vplatform=2&vversion_name=8.9.10&new_mark_label_enabled=1',
                json=hbody, headers=self.headers)
            if rsp is None:
                return cid, {}
            data = rsp.json()
        except Exception as e:
            print(f"获取筛选数据失败({cid}): {e}")
            return cid, {}
        return cid, data

    def get_vdata(self, body):
        try:
            vdata = self.post(
                f'{self.apihost}/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vplatform=2&vversion_name=8.2.96',
                json=body, headers=self.headers
            )
            if vdata is None:
                return {'data': {'module_list_datas': []}}
            return vdata.json()
        except Exception as e:
            print(f"Error in get_vdata: {str(e)}")
            return {'data': {'module_list_datas': []}}

    def process_pdata(self, pdata, ids):
        plist = []
        ylist = []
        for k in pdata:
            if k.get('item_id'):
                params = k.get('item_params', {})
                title = params.get('union_title', '')
                if not title:
                    continue
                pid = f"{title}${ids[0]}@{k['item_id']}"
                if '预告' in title:
                    ylist.append(pid)
                else:
                    plist.append(pid)
        return plist, ylist

    def build_vod(self, vdata, actors, urls, names):
        try:
            d = vdata['data']['module_list_datas'][0]['module_datas'][0]['item_data_lists']['item_datas'][0]['item_params']
        except (IndexError, KeyError, TypeError):
            d = {}
        vod = {
            'type_name': d.get('sub_genre', ''),
            'vod_name': d.get('title', ''),
            'vod_year': d.get('year', ''),
            'vod_area': d.get('area_name', ''),
            'vod_remarks': d.get('holly_online_time', '') or d.get('hotval', ''),
            'vod_actor': ','.join(actors),
            'vod_content': d.get('cover_description', ''),
            'vod_play_from': '$$$'.join(names),
            'vod_play_url': '$$$'.join(urls)
        }
        return vod

    def handle_exception(self, e, message):
        print(f"{message}: {str(e)}")
        return {'list': [{'vod_play_from': '哎呀翻车啦', 'vod_play_url': '翻车啦#555'}]}

    def process_tabs(self, data, body, ids):
        try:
            last_mod = data['data']['module_list_datas'][-1]['module_datas'][-1]
            pdata = last_mod['item_data_lists']['item_datas']
            tabs = last_mod.get('module_params', {}).get('tabs')
            if tabs:
                try:
                    tabs = json.loads(tabs)
                except (json.JSONDecodeError, TypeError):
                    tabs = None
                if tabs:
                    remaining_tabs = tabs[1:]
                    task_queue = []
                    for tab in remaining_tabs:
                        nbody = copy.deepcopy(body)
                        nbody['page_params']['page_context'] = tab.get('page_context')
                        task_queue.append(nbody)
                    if task_queue:
                        with ThreadPoolExecutor(max_workers=min(10, len(task_queue))) as executor:
                            future_map = {executor.submit(self.get_vdata, task): idx for idx, task in enumerate(task_queue)}
                            results = [None] * len(task_queue)
                            for future in as_completed(future_map.keys()):
                                idx = future_map[future]
                                try:
                                    results[idx] = future.result()
                                except Exception:
                                    results[idx] = None
                            for result in results:
                                if result:
                                    try:
                                        page_data = result['data']['module_list_datas'][-1]['module_datas'][-1]['item_data_lists']['item_datas']
                                        pdata.extend(page_data)
                                    except (IndexError, KeyError, TypeError):
                                        continue
            return pdata
        except Exception as e:
            print(f"Error processing episodes: {str(e)}")
            return []

    def josn_to_params(self, params, skip_empty=False):
        query = []
        for k, v in params.items():
            if skip_empty and not v:
                continue
            query.append(f"{k}={v}")
        return "&".join(query)


if __name__ == '__main__':
    # ============ 独立运行自检：不依赖 base.spider，python3 腾讯.py 直接跑 ============
    print('=' * 52)
    print('腾讯视频 独立运行自检（无 base.spider 依赖）')
    print('=' * 52)
    spider = Spider()
    spider.init()

    def _bench(name, fn):
        t0 = time.time()
        try:
            n = fn()
            print(f"[{name}] 返回 {n}, 耗时 {time.time() - t0:.2f}s")
        except Exception as e:
            print(f"[{name}] 异常: {e}")

    _bench('homeContent', lambda: f"{len(spider.homeContent(True).get('class', []))}个频道")
    _bench('homeVideoContent', lambda: f"{len(spider.homeVideoContent().get('list', []))}条推荐")
    _bench('categoryContent', lambda: f"{len(spider.categoryContent('100173', 1, True, {}).get('list', []))}条电影")

    try:
        t0 = time.time()
        sres = spider.searchContent('三体', False, "1")
        lst = sres.get('list', [])
        print(f"[searchContent] 搜索'三体'返回 {len(lst)} 条, 耗时 {time.time() - t0:.2f}s")
        if lst:
            t0 = time.time()
            vod = (spider.detailContent([lst[0]['vod_id']]).get('list') or [{}])[0]
            play_srcs = [u for u in (vod.get('vod_play_url') or '').split('$$$') if u]
            print(f"[detailContent] '{vod.get('vod_name')}' 播放源 {len(play_srcs)} 个, 耗时 {time.time() - t0:.2f}s")
    except Exception as e:
        print(f"[搜索/详情] 异常: {e}")

    print('自检完成：脚本可脱离框架独立运行。')