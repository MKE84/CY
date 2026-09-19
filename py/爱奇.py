#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
爱奇艺影视爬虫（修复版：可脱离 base.spider 独立运行）
======================================================
修复点：
  1. 移除对外部 base.spider 基类的硬依赖：有则用，无则用内置兜底基类；
  2. 请求层：requests.Session 连接复用 + 超时 + 有限重试（速度第一、稳定第二）；
  3. homeVideoContent 四个频道并行抓取，首屏提速约 3~4 倍；
  4. 补齐协议方法 post / cleanText / searchContentPage，兼容各类聚合框架；
  5. __main__ 提供完整独立自检，python3 爱奇.py 直接可跑。
"""
import os
import re
import time
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

# 兼容聚合框架的基类：有就用框架的，没有就退回内置兜底，保证独立运行
try:
    from base.spider import Spider as _BaseSpider
except Exception:
    class _BaseSpider:
        """内置兜底基类：提供协议要求的默认行为"""
        def init(self, extend=""):
            pass

        def fetch(self, url, headers=None, params=None):
            return None

        def post(self, url, headers=None, params=None, data=None, json=None):
            return None

        def cleanText(self, text):
            return text or ''


class Spider(_BaseSpider):
    def __init__(self):
        self.siteUrl = 'https://m.iqiyi.com'
        self.pcwApi = 'https://pcw-api.iqiyi.com'
        self.searchApi = 'https://search.video.iqiyi.com/o'
        self.cacheApi = 'https://cache.video.iqiyi.com'
        self.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
        
        self.channels = {
            '1': {'name': '电影', 'channel_id': '1'},
            '2': {'name': '电视剧', 'channel_id': '2'},
            '3': {'name': '动漫', 'channel_id': '3'},
            '4': {'name': '综艺', 'channel_id': '4'},
            '6': {'name': '纪录片', 'channel_id': '6'},
            '7': {'name': '短片', 'channel_id': '7'},
            '8': {'name': '少儿', 'channel_id': '8'},
        }
        
        self.filters = {
            "1": [
                {"key": "mode", "name": "排序", "value": [
                    {"n": "综合排序", "v": "24"},
                    {"n": "热播榜", "v": "11"},
                    {"n": "新上线", "v": "8"}
                ]},
                {"key": "area", "name": "地区", "value": [
                    {"n": "全部地区", "v": "0"},
                    {"n": "内地", "v": "1"},
                    {"n": "香港", "v": "2"},
                    {"n": "台湾", "v": "3"},
                    {"n": "美国", "v": "4"},
                    {"n": "韩国", "v": "5"},
                    {"n": "日本", "v": "6"},
                    {"n": "泰国", "v": "7"},
                    {"n": "英国", "v": "8"},
                    {"n": "其它", "v": "9"}
                ]},
                {"key": "type", "name": "类型", "value": [
                    {"n": "全部类型", "v": "0"},
                    {"n": "动作", "v": "1"},
                    {"n": "喜剧", "v": "2"},
                    {"n": "爱情", "v": "3"},
                    {"n": "科幻", "v": "4"},
                    {"n": "恐怖", "v": "5"},
                    {"n": "剧情", "v": "6"},
                    {"n": "战争", "v": "7"},
                    {"n": "悬疑", "v": "8"},
                    {"n": "动画", "v": "9"},
                    {"n": "奇幻", "v": "10"},
                    {"n": "冒险", "v": "11"},
                    {"n": "犯罪", "v": "12"},
                    {"n": "惊悚", "v": "13"}
                ]},
                {"key": "year", "name": "年份", "value": [
                    {"n": "全部年份", "v": "0"},
                    {"n": "2026", "v": "2026"},
                    {"n": "2025", "v": "2025"},
                    {"n": "2024", "v": "2024"},
                    {"n": "2023", "v": "2023"},
                    {"n": "2022", "v": "2022"},
                    {"n": "2021", "v": "2021"},
                    {"n": "2020", "v": "2020"},
                    {"n": "2019", "v": "2019"},
                    {"n": "2018", "v": "2018"},
                    {"n": "2017", "v": "2017"},
                    {"n": "2016", "v": "2016"},
                    {"n": "2015", "v": "2015"},
                    {"n": "2011-2014", "v": "2011_2014"},
                    {"n": "2000-2010", "v": "2000_2010"},
                    {"n": "90年代", "v": "1990_1999"},
                    {"n": "80年代", "v": "1980_1989"},
                    {"n": "更早", "v": "-1980"}
                ]},
                {"key": "pay", "name": "资费", "value": [
                    {"n": "全部资费", "v": "0"},
                    {"n": "免费", "v": "1"},
                    {"n": "付费", "v": "2"}
                ]}
            ],
            "2": [
                {"key": "mode", "name": "排序", "value": [
                    {"n": "综合排序", "v": "24"},
                    {"n": "热播榜", "v": "11"},
                    {"n": "新上线", "v": "8"}
                ]},
                {"key": "area", "name": "地区", "value": [
                    {"n": "全部地区", "v": "0"},
                    {"n": "内地", "v": "1"},
                    {"n": "港剧", "v": "2"},
                    {"n": "韩剧", "v": "5"},
                    {"n": "美剧", "v": "4"},
                    {"n": "日剧", "v": "6"},
                    {"n": "泰剧", "v": "7"},
                    {"n": "台湾地区", "v": "3"},
                    {"n": "英剧", "v": "8"},
                    {"n": "其它", "v": "9"}
                ]},
                {"key": "type", "name": "类型", "value": [
                    {"n": "全部类型", "v": "0"},
                    {"n": "自制", "v": "1"},
                    {"n": "古装", "v": "2"},
                    {"n": "言情", "v": "3"},
                    {"n": "武侠", "v": "4"},
                    {"n": "偶像", "v": "5"},
                    {"n": "家庭", "v": "6"},
                    {"n": "青春", "v": "7"},
                    {"n": "都市", "v": "8"},
                    {"n": "喜剧", "v": "9"},
                    {"n": "战争", "v": "10"},
                    {"n": "军旅", "v": "11"},
                    {"n": "谍战", "v": "12"},
                    {"n": "悬疑", "v": "13"},
                    {"n": "罪案", "v": "14"},
                    {"n": "穿越", "v": "15"},
                    {"n": "宫廷", "v": "16"},
                    {"n": "历史", "v": "17"},
                    {"n": "神话", "v": "18"},
                    {"n": "科幻", "v": "19"},
                    {"n": "年代", "v": "20"},
                    {"n": "农村", "v": "21"},
                    {"n": "商战", "v": "22"},
                    {"n": "剧情", "v": "23"},
                    {"n": "奇幻", "v": "24"},
                    {"n": "网剧", "v": "25"},
                    {"n": "竖短片", "v": "26"}
                ]},
                {"key": "year", "name": "年份", "value": [
                    {"n": "全部年份", "v": "0"},
                    {"n": "2026", "v": "2026"},
                    {"n": "2025", "v": "2025"},
                    {"n": "2024", "v": "2024"},
                    {"n": "2023", "v": "2023"},
                    {"n": "2022", "v": "2022"},
                    {"n": "2021", "v": "2021"},
                    {"n": "2020", "v": "2020"},
                    {"n": "2019", "v": "2019"},
                    {"n": "2018", "v": "2018"},
                    {"n": "2017", "v": "2017"},
                    {"n": "2016", "v": "2016"},
                    {"n": "2015", "v": "2015"},
                    {"n": "2011-2014", "v": "2011_2014"},
                    {"n": "2000-2010", "v": "2000_2010"},
                    {"n": "90年代", "v": "1990_1999"},
                    {"n": "80年代", "v": "1980_1989"},
                    {"n": "更早", "v": "-1980"}
                ]},
                {"key": "pay", "name": "资费", "value": [
                    {"n": "全部资费", "v": "0"},
                    {"n": "免费", "v": "1"},
                    {"n": "付费", "v": "2"}
                ]}
            ],
            "3": [
                {"key": "mode", "name": "排序", "value": [
                    {"n": "综合排序", "v": "24"},
                    {"n": "热播榜", "v": "11"},
                    {"n": "新上线", "v": "8"}
                ]},
                {"key": "area", "name": "地区", "value": [
                    {"n": "全部地区", "v": "0"},
                    {"n": "国产", "v": "1"},
                    {"n": "日本", "v": "6"},
                    {"n": "欧美", "v": "4"},
                    {"n": "韩国", "v": "5"},
                    {"n": "其它", "v": "9"}
                ]},
                {"key": "type", "name": "类型", "value": [
                    {"n": "全部类型", "v": "0"},
                    {"n": "热血", "v": "1"},
                    {"n": "恋爱", "v": "2"},
                    {"n": "科幻", "v": "3"},
                    {"n": "奇幻", "v": "4"},
                    {"n": "冒险", "v": "5"},
                    {"n": "搞笑", "v": "6"},
                    {"n": "战斗", "v": "7"},
                    {"n": "神魔", "v": "8"},
                    {"n": "竞技", "v": "9"},
                    {"n": "日常", "v": "10"},
                    {"n": "校园", "v": "11"},
                    {"n": "治愈", "v": "12"},
                    {"n": "悬疑", "v": "13"}
                ]},
                {"key": "year", "name": "年份", "value": [
                    {"n": "全部年份", "v": "0"},
                    {"n": "2026", "v": "2026"},
                    {"n": "2025", "v": "2025"},
                    {"n": "2024", "v": "2024"},
                    {"n": "2023", "v": "2023"},
                    {"n": "2022", "v": "2022"},
                    {"n": "2021", "v": "2021"},
                    {"n": "2020", "v": "2020"},
                    {"n": "2019", "v": "2019"},
                    {"n": "2018", "v": "2018"},
                    {"n": "2017", "v": "2017"},
                    {"n": "更早", "v": "-2017"}
                ]},
                {"key": "pay", "name": "资费", "value": [
                    {"n": "全部资费", "v": "0"},
                    {"n": "免费", "v": "1"},
                    {"n": "付费", "v": "2"}
                ]}
            ],
            "4": [
                {"key": "mode", "name": "排序", "value": [
                    {"n": "综合排序", "v": "24"},
                    {"n": "热播榜", "v": "11"},
                    {"n": "新上线", "v": "8"}
                ]},
                {"key": "area", "name": "地区", "value": [
                    {"n": "全部地区", "v": "0"},
                    {"n": "内地", "v": "1"},
                    {"n": "港台", "v": "2"},
                    {"n": "日韩", "v": "5"},
                    {"n": "欧美", "v": "4"},
                    {"n": "其它", "v": "9"}
                ]},
                {"key": "type", "name": "类型", "value": [
                    {"n": "全部类型", "v": "0"},
                    {"n": "真人秀", "v": "1"},
                    {"n": "脱口秀", "v": "2"},
                    {"n": "选秀", "v": "3"},
                    {"n": "访谈", "v": "4"},
                    {"n": "情感", "v": "5"},
                    {"n": "生活", "v": "6"},
                    {"n": "美食", "v": "7"},
                    {"n": "旅游", "v": "8"},
                    {"n": "游戏", "v": "9"},
                    {"n": "音乐", "v": "10"},
                    {"n": "时尚", "v": "11"},
                    {"n": "文化", "v": "12"},
                    {"n": "搞笑", "v": "13"}
                ]},
                {"key": "year", "name": "年份", "value": [
                    {"n": "全部年份", "v": "0"},
                    {"n": "2026", "v": "2026"},
                    {"n": "2025", "v": "2025"},
                    {"n": "2024", "v": "2024"},
                    {"n": "2023", "v": "2023"},
                    {"n": "2022", "v": "2022"},
                    {"n": "2021", "v": "2021"},
                    {"n": "2020", "v": "2020"},
                    {"n": "2019", "v": "2019"},
                    {"n": "更早", "v": "-2019"}
                ]},
                {"key": "pay", "name": "资费", "value": [
                    {"n": "全部资费", "v": "0"},
                    {"n": "免费", "v": "1"},
                    {"n": "付费", "v": "2"}
                ]}
            ],
            "6": [
                {"key": "mode", "name": "排序", "value": [
                    {"n": "综合排序", "v": "24"},
                    {"n": "热播榜", "v": "11"},
                    {"n": "新上线", "v": "8"}
                ]},
                {"key": "area", "name": "地区", "value": [
                    {"n": "全部地区", "v": "0"},
                    {"n": "内地", "v": "1"},
                    {"n": "国外", "v": "9"}
                ]},
                {"key": "type", "name": "类型", "value": [
                    {"n": "全部类型", "v": "0"},
                    {"n": "自然", "v": "1"},
                    {"n": "历史", "v": "2"},
                    {"n": "人文", "v": "3"},
                    {"n": "社会", "v": "4"},
                    {"n": "科技", "v": "5"},
                    {"n": "探险", "v": "6"},
                    {"n": "军事", "v": "7"},
                    {"n": "传记", "v": "8"}
                ]},
                {"key": "year", "name": "年份", "value": [
                    {"n": "全部年份", "v": "0"},
                    {"n": "2026", "v": "2026"},
                    {"n": "2025", "v": "2025"},
                    {"n": "2024", "v": "2024"},
                    {"n": "2023", "v": "2023"},
                    {"n": "2022", "v": "2022"},
                    {"n": "2021", "v": "2021"},
                    {"n": "2020", "v": "2020"},
                    {"n": "更早", "v": "-2020"}
                ]},
                {"key": "pay", "name": "资费", "value": [
                    {"n": "全部资费", "v": "0"},
                    {"n": "免费", "v": "1"},
                    {"n": "付费", "v": "2"}
                ]}
            ],
            "7": [
                {"key": "mode", "name": "排序", "value": [
                    {"n": "综合排序", "v": "24"},
                    {"n": "热播榜", "v": "11"},
                    {"n": "新上线", "v": "8"}
                ]},
                {"key": "year", "name": "年份", "value": [
                    {"n": "全部年份", "v": "0"},
                    {"n": "2026", "v": "2026"},
                    {"n": "2025", "v": "2025"},
                    {"n": "2024", "v": "2024"},
                    {"n": "2023", "v": "2023"},
                    {"n": "2022", "v": "2022"}
                ]},
                {"key": "pay", "name": "资费", "value": [
                    {"n": "全部资费", "v": "0"},
                    {"n": "免费", "v": "1"},
                    {"n": "付费", "v": "2"}
                ]}
            ],
            "8": [
                {"key": "mode", "name": "排序", "value": [
                    {"n": "综合排序", "v": "24"},
                    {"n": "热播榜", "v": "11"},
                    {"n": "新上线", "v": "8"}
                ]},
                {"key": "type", "name": "类型", "value": [
                    {"n": "全部类型", "v": "0"},
                    {"n": "动画", "v": "1"},
                    {"n": "儿歌", "v": "2"},
                    {"n": "早教", "v": "3"},
                    {"n": "益智", "v": "4"},
                    {"n": "故事", "v": "5"},
                    {"n": "科普", "v": "6"}
                ]},
                {"key": "year", "name": "年份", "value": [
                    {"n": "全部年份", "v": "0"},
                    {"n": "2026", "v": "2026"},
                    {"n": "2025", "v": "2025"},
                    {"n": "2024", "v": "2024"},
                    {"n": "2023", "v": "2023"},
                    {"n": "2022", "v": "2022"},
                    {"n": "2021", "v": "2021"},
                    {"n": "更早", "v": "-2021"}
                ]},
                {"key": "pay", "name": "资费", "value": [
                    {"n": "全部资费", "v": "0"},
                    {"n": "免费", "v": "1"},
                    {"n": "付费", "v": "2"}
                ]}
            ]
        }

    def getName(self):
        return "爱奇艺影视"

    def init(self, extend=""):
        # 惰性初始化：无论是否被框架调用 init 都能工作
        if not getattr(self, '_session', None):
            self._session = requests.Session()
            self._session.headers.update({
                'User-Agent': self.userAgent,
                'Referer': self.siteUrl,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
            })
        return None

    def fetch(self, url, headers=None, params=None, retries=2, timeout=10):
        """GET 请求：Session 连接复用 + 超时 + 有限重试（速度第一、稳定第二）"""
        if not getattr(self, '_session', None):
            self.init()
        req_headers = headers or self._session.headers
        for attempt in range(retries + 1):
            try:
                response = self._session.get(url, headers=req_headers, params=params or None, timeout=timeout)
                response.raise_for_status()
                return response
            except Exception as e:
                if attempt >= retries:
                    print(f"请求失败: {url}, 错误: {e}")
                    return None
                time.sleep(0.3 * (attempt + 1))

    def post(self, url, headers=None, params=None, data=None, json=None, retries=2, timeout=10):
        """POST 请求：供聚合框架协议调用，与 fetch 相同的容错策略"""
        if not getattr(self, '_session', None):
            self.init()
        req_headers = headers or self._session.headers
        for attempt in range(retries + 1):
            try:
                response = self._session.post(url, headers=req_headers, params=params or None,
                                              data=data, json=json, timeout=timeout)
                response.raise_for_status()
                return response
            except Exception as e:
                if attempt >= retries:
                    print(f"POST请求失败: {url}, 错误: {e}")
                    return None
                time.sleep(0.3 * (attempt + 1))

    def cleanText(self, text):
        return re.sub(r'<!--.*?-->', '', text or '', flags=re.S)

    def searchContentPage(self, key, quick, pg=1):
        return self.searchContent(key, quick, pg)

    def homeContent(self, filter):
        result = {}
        classes = []
        for k, v in self.channels.items():
            classes.append({
                'type_id': k,
                'type_name': v['name']
            })
        result['class'] = classes
        if filter:
            result['filters'] = self.filters
        return result

    def homeVideoContent(self):
        """首页推荐：四个频道并行抓取，显著提速；失败频道静默跳过保证稳定"""
        result = {'list': []}
        channel_ids = ['2', '1', '3', '4']
        videos = []

        def _fetch_channel(cid):
            out = []
            try:
                url = f'{self.pcwApi}/search/recommend/list'
                params = {
                    'channel_id': self.channels[cid]['channel_id'],
                    'data_type': '1',
                    'mode': '11',
                    'page_id': '1',
                    'ret_num': '12',
                    'session': ''
                }
                response = self.fetch(url, params=params)
                if not response:
                    return out
                data = response.json()
                if data.get('code') == 'A00000' and data.get('data', {}).get('list'):
                    for item in data['data']['list'][:6]:
                        out.append(self._parseVideoItem(item))
            except Exception as e:
                print(f"获取首页频道{cid}视频失败: {e}")
            return out

        with ThreadPoolExecutor(max_workers=len(channel_ids)) as executor:
            future_map = {executor.submit(_fetch_channel, cid): cid for cid in channel_ids}
            channel_videos = {}
            for future in as_completed(future_map):
                cid = future_map[future]
                try:
                    channel_videos[cid] = future.result()
                except Exception:
                    channel_videos[cid] = []
        # 按频道顺序合并，保证输出稳定有序
        for cid in channel_ids:
            videos.extend(channel_videos.get(cid, []))
            if len(videos) >= 24:
                break
        result['list'] = videos[:24]
        return result

    def categoryContent(self, tid, pg, filter, extend):
        result = {}
        videos = []
        try:
            channel_info = self.channels.get(tid, {})
            channel_id = channel_info.get('channel_id', '2')
            
            mode = extend.get('mode', '24') if extend else '24'
            
            url = f'{self.pcwApi}/search/recommend/list'
            params = {
                'channel_id': channel_id,
                'data_type': '1',
                'mode': mode,
                'page_id': str(pg),
                'ret_num': '48',
                'session': ''
            }
            
            response = self.fetch(url, params=params)
            if response:
                data = response.json()
                if data.get('code') == 'A00000' and data.get('data', {}).get('list'):
                    for item in data['data']['list']:
                        videos.append(self._parseVideoItem(item))
                    
                    has_next = data['data'].get('has_next', 0)
                    pagecount = pg + 1 if has_next else pg
                    total = len(videos) * pg
                else:
                    pagecount = pg
                    total = len(videos)
            else:
                pagecount = pg
                total = len(videos)
        except Exception as e:
            print(f"获取分类内容失败: {e}")
            pagecount = pg
            total = len(videos)
        
        result['list'] = videos
        result['page'] = pg
        result['pagecount'] = pagecount
        result['limit'] = 48
        result['total'] = total
        return result

    def detailContent(self, ids):
        result = {}
        try:
            video_id = ids[0]
            album_id = video_id.split('_')[0] if '_' in video_id else video_id
            
            # 获取剧集列表
            url = f'{self.pcwApi}/albums/album/avlistinfo'
            params = {
                'aid': album_id,
                'page': '1',
                'size': '30'
            }
            response = self.fetch(url, params=params)
            
            episodes = []
            first_ep = {}
            album_name = ''
            album_pic = ''
            album_desc = ''
            directors = []
            actors = []
            
            if response:
                data = response.json()
                if data.get('code') == 'A00000' and data.get('data', {}).get('epsodelist'):
                    album_data = data['data']
                    episodes = album_data['epsodelist']
                    first_ep = episodes[0] if episodes else {}
            
            # 获取专辑详细信息（用于获取正确的剧名、导演、演员、简介）
            # 电视剧通过avlistinfo获取tvId后再查baseinfo，电影直接用albumId查
            tv_id = first_ep.get('tvId') if first_ep else None
            if not tv_id:
                tv_id = album_id
            
            if tv_id:
                base_url = f'{self.pcwApi}/video/video/baseinfo/{tv_id}'
                base_response = self.fetch(base_url)
                if base_response:
                    base_data = base_response.json()
                    if base_data.get('code') == 'A00000' and base_data.get('data'):
                        base_info = base_data['data']
                        album_name = base_info.get('albumName', '')
                        album_pic = base_info.get('albumImageUrl', '')
                        album_desc = base_info.get('description', '')
                        people = base_info.get('people', {})
                        if people:
                            director_list = people.get('director', [])
                            directors = [d.get('name', '') for d in director_list if d.get('name')]
                            actor_list = people.get('main_charactor', [])
                            actors = [a.get('name', '') for a in actor_list if a.get('name')]
                        # 电影可能没有avlistinfo数据，用baseinfo补充播放链接
                        if not episodes and base_info.get('playUrl'):
                            episodes = [{
                                'shortTitle': base_info.get('name', album_name),
                                'name': base_info.get('name', album_name),
                                'playUrl': base_info.get('playUrl', ''),
                                'imageUrl': base_info.get('imageUrl', ''),
                                'duration': base_info.get('duration', ''),
                                'description': base_info.get('description', '')
                            }]
            
            # 如果baseinfo获取失败，从avlistinfo补充
            if not album_name and first_ep:
                album_name = self._extractAlbumName(first_ep.get('name', ''), first_ep.get('shortTitle', ''))
            if not album_pic and first_ep:
                album_pic = first_ep.get('imageUrl', '')
            if not album_desc and first_ep:
                album_desc = first_ep.get('description', '')
            if not directors and first_ep and first_ep.get('people'):
                director_list = first_ep['people'].get('director', [])
                directors = [d.get('name', '') for d in director_list if d.get('name')]
            if not actors and first_ep and first_ep.get('people'):
                actor_list = first_ep['people'].get('main_charactor', [])
                actors = [a.get('name', '') for a in actor_list if a.get('name')]
            
            # 构建播放列表
            play_from = ['爱奇艺']
            play_urls = []
            
            for ep in episodes:
                ep_name = ep.get('shortTitle', ep.get('name', ''))
                ep_url = ep.get('playUrl', '')
                if ep_url:
                    # 转为移动端URL，提升兼容性
                    ep_url = ep_url.replace('http://www.iqiyi.com/', 'https://m.iqiyi.com/')
                    ep_url = ep_url.replace('https://www.iqiyi.com/', 'https://m.iqiyi.com/')
                    play_urls.append(f"{ep_name}${ep_url}")
            
            play_url = '#'.join(play_urls)
            
            # 清理简介中的多余换行和空格
            album_desc = album_desc.replace('\n\n', '\n').strip() if album_desc else ''
            
            vod = {
                "vod_id": video_id,
                "vod_name": album_name,
                "vod_pic": album_pic,
                "vod_remarks": f"共{len(episodes)}集" if len(episodes) > 1 else (first_ep.get('duration', '') or '电影'),
                "vod_actor": ' '.join(actors[:8]),
                "vod_director": ' '.join(directors[:3]),
                "vod_content": album_desc,
                "vod_play_from": "$$$".join(play_from),
                "vod_play_url": "$$$".join([play_url])
            }
            result['list'] = [vod]
        except Exception as e:
            print(f"获取详情失败: {e}")
            result['list'] = []
        return result

    def _extractAlbumName(self, name, short_title):
        """智能提取剧名"""
        text = name or short_title or ''
        if not text:
            return ''
        # 匹配 "剧名第N集" 格式
        match = re.match(r'^(.*?)(第\d+集|第[一二三四五六七八九十百]+集|预告|片花|花絮|特辑)', text)
        if match:
            name = match.group(1).strip()
            if name:
                return name
        # 如果是 "第N集" 开头，无法提取，返回原值
        if text.startswith('第'):
            return text
        return text

    def searchContent(self, key, quick, pg=1):
        result = {}
        videos = []
        try:
            url = self.searchApi
            params = {
                'if': 'html5',
                'key': key,
                'pageNum': str(pg),
                'pageSize': '25'
            }
            response = self.fetch(url, params=params)
            if response:
                data = response.json()
                if data.get('data', {}).get('docinfos'):
                    for item in data['data']['docinfos']:
                        album_info = item.get('albumDocInfo', {})
                        if album_info and album_info.get('albumId'):
                            # 过滤掉无效结果
                            title = album_info.get('albumTitle', '')
                            if not title:
                                continue
                            videos.append({
                                "vod_id": str(album_info.get('albumId', '')),
                                "vod_name": title,
                                "vod_pic": album_info.get('albumVImage', '') or album_info.get('albumImg', ''),
                                "vod_remarks": album_info.get('tvFocus', '') or f"{album_info.get('itemTotalNumber', 0)}集"
                            })
                    result = {
                        'list': videos,
                        'page': pg,
                        'pagecount': 999,
                        'limit': 25,
                        'total': len(videos)
                    }
        except Exception as e:
            print(f"搜索失败: {e}")
        if not result:
            result = {'list': videos, 'page': pg, 'pagecount': pg, 'limit': 25, 'total': len(videos)}
        return result

    def searchContentPage(self, key, quick, pg=1):
        return self.searchContent(key, quick, pg)

    def playerContent(self, flag, id, vipFlags):
        result = {}
        try:
            play_url = id
            # 统一转为移动端URL，提升兼容性
            if play_url and play_url.startswith('http'):
                play_url = play_url.replace('http://www.iqiyi.com/', 'https://m.iqiyi.com/')
                play_url = play_url.replace('https://www.iqiyi.com/', 'https://m.iqiyi.com/')

            if self.isVideoFormat(play_url):
                # 直链直接播放，不经过解析
                result["parse"] = 0
                result["url"] = play_url
            else:
                # 网页地址交给播放器走网页嗅探/解析。
                # 注意：不带非标准 jx 字段——解析接口未配置时 jx="1" 会让播放一直卡在加载。
                # 某个视频官方页嗅探不出来时，可设环境变量 IQIYI_PARSE=解析站模板强制走解析
                result["parse"] = 1
                parse_site = os.environ.get('IQIYI_PARSE', '').strip()
                if parse_site:
                    if '{url}' in parse_site:
                        result["url"] = parse_site.replace('{url}', play_url)
                    else:
                        sep = '&' if '?' in parse_site else '?'
                        result["url"] = f"{parse_site}{sep}url={play_url}"
                else:
                    result["url"] = play_url

            result["header"] = {
                "User-Agent": self.userAgent,
                "Referer": "https://m.iqiyi.com/",
                "Origin": "https://m.iqiyi.com"
            }
        except Exception as e:
            print(f"获取播放内容失败: {e}")
        return result

    def isVideoFormat(self, url):
        video_formats = ['.mp4', '.m3u8', '.ts', '.mkv', '.avi', '.flv', '.webm']
        if url and url.startswith('http'):
            for fmt in video_formats:
                if url.lower().find(fmt) > -1:
                    return True
        return False

    def manualVideoCheck(self):
        return False

    def localProxy(self, param):
        return None

    def _parseVideoItem(self, item):
        return {
            "vod_id": str(item.get('albumId', '')),
            "vod_name": item.get('name', ''),
            "vod_pic": item.get('imageUrl', ''),
            "vod_remarks": item.get('focus', '') or f"更新至{item.get('latestOrder', 0)}集",
            "vod_year": str(item.get('period', ''))[:4] if item.get('period') else '',
            "vod_area": ','.join(item.get('categories', []))
        }

if __name__ == '__main__':
    # ============ 独立运行自检：不依赖 base.spider，python3 爱奇.py 直接跑 ============
    print('=' * 52)
    print('爱奇艺影视 独立运行自检（无 base.spider 依赖）')
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
    _bench('categoryContent', lambda: f"{len(spider.categoryContent('1', 1, True, {}).get('list', []))}条电影")

    try:
        t0 = time.time()
        sres = spider.searchContent('三体', False, 1)
        lst = sres.get('list', [])
        print(f"[searchContent] 搜索'三体'返回 {len(lst)} 条, 耗时 {time.time() - t0:.2f}s")
        if lst:
            t0 = time.time()
            vod = (spider.detailContent([lst[0]['vod_id']]).get('list') or [{}])[0]
            ep_count = (vod.get('vod_play_url') or '').count('#') + 1 if vod.get('vod_play_url') else 0
            print(f"[detailContent] '{vod.get('vod_name')}' 共{ep_count}个播放项, 耗时 {time.time() - t0:.2f}s")
    except Exception as e:
        print(f"[搜索/详情] 异常: {e}")

    print('自检完成：脚本可脱离框架独立运行。')