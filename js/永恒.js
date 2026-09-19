// ============================================================
// 永恒.js —— 豆瓣影视源（修复版 + 多源自动扫描）
// ------------------------------------------------------------
// 协议：__JS_SPIDER__（TVBox / WebHTV 通用 JS 源）
// 数据源：m.douban.com rexxar API（实时热门/榜单/筛选/搜索/详情）
//
// 修复内容（相对原混淆版）：
//  1. detail / search 原为空的半成品，已完整实现（导演/主演/年份/
//     地区/简介/评分/更新状态）
//  2. movie.douban.com/j/* 系列接口已被豆瓣封禁(403/302登录跳转)，
//     全部切换到可用的 m.douban.com rexxar/api/v2/* 接口
//  3. 所有网络请求 try/catch + 空值保护，单个接口失败不影响其它
//  4. 纯豆瓣数据源：play 忠实原版行为，不内置任何第三方播放链
//  5. 自动扫描：详情页无播放料时，自动扫描订阅内其他源的站点
//     （视觉/毒舌，取到 m3u8 直链的源），把能搜到的线路显示在下方，
//     点击线路直接播放。扫描结果按片名缓存，重复打开秒回；
//     单个源超时/失败自动跳过，不影响其它源。
//     腾讯/爱奇官方源无法外部取链；奇优搜索走 POST；七猫搜索无结果；
//     4K/兄弟播放器 JS 加密取不到直链；如需扩展按 SCAN_SOURCES 加条目。
// ============================================================

var SPIDER = {
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  headers: {},
  filter: {}
};

SPIDER.headers = {
  'User-Agent': SPIDER.UA,
  'Referer': 'https://m.douban.com/',
  'Accept': 'application/json, text/plain, */*'
};

// ---------- 基础工具 ----------

// req 兼容层：优先用 TVBox 的 req()，退化为 fetch()
// 2026-09 加固：统一 6s 超时，避免单个站点卡死整个扫描流程
function _req(url) {
  try {
    if (typeof req === 'function') {
      var r = req(url, { headers: SPIDER.headers, timeout: 6000 });
      return (r && r.content) ? r.content : '';
    }
    if (typeof fetch === 'function') {
      var opt = { headers: SPIDER.headers };
      if (typeof AbortController === 'function') {
        var ac = new AbortController();
        opt.signal = ac.signal;
        setTimeout(function () { ac.abort(); }, 6000);
      }
      var f = fetch(url, opt);
      return (f && typeof f.text === 'function') ? (f.text() || '') : '';
    }
  } catch (e) {}
  return '';
}

function _getJSON(url) {
  var s = _req(url);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// 取 extend 过滤参数：extend 是 {1:'xx',2:'yy'} 形式的对象
function _ext(extend, key, def) {
  try {
    if (extend && typeof extend === 'object') {
      var v = extend[key];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
  } catch (e) {}
  return def;
}

// 逗号拼接非空参数（筛选 tags 用）
function _tags() {
  var arr = [];
  for (var i = 0; i < arguments.length; i++) {
    if (arguments[i] !== '' && arguments[i] !== undefined && arguments[i] !== null) arr.push(arguments[i]);
  }
  return encodeURI(arr.join(','));
}

// 列表项 -> vod 字段（rexxar subject_collection_items / recommend items）
function _mapItem(it) {
  if (!it) return null;
  var pic = '';
  if (it.pic) pic = it.pic.normal || it.pic.large || it.pic.medium || '';
  if (!pic && it.cover_url) pic = it.cover_url;
  var rate = (it.rating && it.rating.value !== undefined && it.rating.value !== null) ? String(it.rating.value) : '0';
  if (rate === '0' || rate === '0.0') rate = '暂无评分';
  var honor = '';
  if (it.honor_infos && it.honor_infos.length > 0 && it.honor_infos[0] && it.honor_infos[0].title) honor = it.honor_infos[0].title;
  var rem = rate;
  if (honor) rem = rem + ' ' + honor;
  return {
    vod_id: String(it.id),
    vod_name: it.title || '',
    vod_pic: pic,
    vod_remarks: rem
  };
}

// 合并多个 collection（去重）
function _mergeCollections(cols, page) {
  var seen = {};
  var arr = [];
  for (var c = 0; c < cols.length; c++) {
    var d = _getJSON(cols[c]);
    if (d && d.subject_collection_items) {
      for (var i = 0; i < d.subject_collection_items.length; i++) {
        var it = d.subject_collection_items[i];
        if (!it || !it.id || seen[it.id]) continue;
        seen[it.id] = 1;
        var m = _mapItem(it);
        if (m) arr.push(m);
      }
    }
  }
  return { list: arr, page: page, pagecount: 1, limit: 100, total: arr.length };
}

// 分页对象
function _pageObj(list, page, perPage, total) {
  var pc = 1;
  if (total && total > 0) {
    pc = Math.ceil(total / perPage);
    if (pc < 1) pc = 1;
    if (pc > 50) pc = 50;
  }
  return {
    list: list,
    page: page,
    pagecount: pc,
    limit: perPage,
    total: total || list.length
  };
}

// subject_collection 列表页公共拉取
function _collection(url, page, perPage) {
  var d = _getJSON(url);
  var arr = [];
  if (d && d.subject_collection_items && d.subject_collection_items.length > 0) {
    for (var i = 0; i < d.subject_collection_items.length; i++) {
      var m = _mapItem(d.subject_collection_items[i]);
      if (m) arr.push(m);
    }
  }
  return _pageObj(arr, page, perPage, d ? (d.total || 0) : 0);
}

// recommend 筛选列表公共拉取（按 type 过滤 movie/tv）
function _recommend(url, page, type) {
  var d = _getJSON(url);
  var arr = [];
  if (d && d.items && d.items.length > 0) {
    for (var i = 0; i < d.items.length; i++) {
      var it = d.items[i];
      if (type && it.type !== type) continue;
      var m = _mapItem(it);
      if (m) arr.push(m);
    }
  }
  return _pageObj(arr, page, 20, d ? (d.total || 0) : 0);
}

// ---------- 静态标签表（接口失败时的兜底） ----------

var MOVIE_TAGS = ['热门','最新','经典','可播放','豆瓣高分','冷门佳片','华语','欧美','韩国','日本','动作','喜剧','爱情','科幻','动画','悬疑','惊悚','恐怖','剧情','战争','纪录','短片','情色','运动','歌舞','音乐','传记','犯罪','黑色电影','冒险','灾难','西部','奇幻','古装','武侠','家庭','同性','儿童','舞台艺术','武术','丧尸','黑白','宝莱坞','北欧'];
var TV_TAGS = ['热门','最新','经典','可播放','豆瓣高分','华语','欧美','日剧','韩剧','英剧','港剧','台剧','泰剧','美剧','剧情','喜剧','爱情','科幻','动作','悬疑','犯罪','冒险','灾难','战争','警匪','动画','儿童','奇幻','武侠','古装','历史','传记','运动','歌舞','音乐','真人秀','脱口秀','纪录片','家庭','同性','西部','谍战','刑侦','灵异','惊悚','恐怖','丧尸','医疗','律政','美食','亲子','游戏','体育'];
var MOVIE_GENRES = ['剧情','喜剧','动作','爱情','科幻','动画','悬疑','惊悚','恐怖','纪录片','短片','情色','运动','歌舞','音乐','传记','犯罪','冒险','灾难','西部','奇幻','古装','武侠','家庭','同性','儿童','战争'];
var MOVIE_AREAS = ['中国大陆','美国','香港','台湾','日本','韩国','英国','法国','德国','意大利','西班牙','印度','泰国','俄罗斯','加拿大','澳大利亚','爱尔兰','瑞典','丹麦','巴西','阿根廷'];
var TV_GENRES = ['全部剧集','全部综艺','电视剧','综艺','国产剧','港剧','台剧','日剧','韩剧','美剧','英剧','泰剧','海外剧'];
var TV_AREAS = ['中国大陆','香港','台湾','美国','日本','韩国','英国','泰国'];
var TV_PLATFORMS = ['全部平台','爱奇艺','腾讯视频','优酷','芒果TV','哔哩哔哩','Netflix','Disney+','HBO','Apple TV+','Amazon','Hulu','FOX','NBC','CBS','ITV','BBC','NHK','TBS','TVB','ATV','SBS','KBS','MBC','OCN','tvN'];
var YEARS = ['全部','2020年代','2026','2025','2024','2023','2022','2021','2020','2019','2010年代','2000年代','90年代','80年代','70年代','60年代','更早'];
var SORTS = [ {n:'综合排序', v:'U'}, {n:'最新上映', v:'R'}, {n:'最高评分', v:'S'} ];

// ---------- init：构建筛选 ----------

function _initMovieFilter() {
  try {
    var rec = _getJSON('https://m.douban.com/rexxar/api/v2/movie/recommend?refresh=0&start=0&count=1&uncollect=false&sort=U&tags=');
    if (rec && rec.recommend_categories && rec.recommend_categories.length >= 2) {
      var cat0 = rec.recommend_categories[0];
      var cat1 = rec.recommend_categories[1];
      if (cat0 && cat0.data && cat0.data.length > 3) {
        MOVIE_GENRES.length = 0;
        for (var i = 1; i < cat0.data.length; i++) if (cat0.data[i].text) MOVIE_GENRES.push(cat0.data[i].text);
      }
      if (cat1 && cat1.data && cat1.data.length > 3) {
        MOVIE_AREAS.length = 0;
        for (var j = 1; j < cat1.data.length; j++) if (cat1.data[j].text) MOVIE_AREAS.push(cat1.data[j].text);
      }
      if (rec.sorts && rec.sorts.length > 0) {
        SORTS.length = 0;
        for (var k = 0; k < rec.sorts.length; k++) if (rec.sorts[k].text) SORTS.push({ n: rec.sorts[k].text, v: rec.sorts[k].name || rec.sorts[k].text });
      }
    }
    var ft = _getJSON('https://m.douban.com/rexxar/api/v2/movie/recommend/filter_tags');
    if (ft && ft.tags && ft.tags.length > 0) {
      for (var t = 0; t < ft.tags.length; t++) {
        if (ft.tags[t].type === '年代' && ft.tags[t].tags && ft.tags[t].tags.length > 0) {
          YEARS.length = 0;
          for (var y = 0; y < ft.tags[t].tags.length; y++) YEARS.push(ft.tags[t].tags[y]);
          break;
        }
      }
    }
  } catch (e) {}
  SPIDER.filter.moviefilter = [
    { key: 1, name: '类型', value: _toOptions(MOVIE_GENRES) },
    { key: 2, name: '地区', value: _toOptions(MOVIE_AREAS) },
    { key: 3, name: '年代', value: _toOptions(YEARS) },
    { key: 4, name: '标签', value: _toOptions(MOVIE_TAGS) },
    { key: 5, name: '排序', value: SORTS }
  ];
}

function _initTvFilter() {
  try {
    var rec = _getJSON('https://m.douban.com/rexxar/api/v2/tv/recommend?refresh=0&start=0&count=1&uncollect=false&sort=U&tags=');
    if (rec && rec.recommend_categories && rec.recommend_categories.length >= 2) {
      var c0 = rec.recommend_categories[0];
      var c1 = rec.recommend_categories[1];
      if (c0 && c0.data && c0.data.length > 3) {
        TV_GENRES.length = 0;
        for (var i = 1; i < c0.data.length; i++) {
          var name = c0.data[i].text;
          if (name) TV_GENRES.push(name.replace('全部剧集', '电视剧').replace('全部综艺', '综艺'));
        }
      }
      if (c1 && c1.data && c1.data.length > 3) {
        TV_AREAS.length = 0;
        for (var j = 1; j < c1.data.length; j++) if (c1.data[j].text) TV_AREAS.push(c1.data[j].text);
      }
      if (rec.sorts && rec.sorts.length > 0) {
        SORTS.length = 0;
        for (var k = 0; k < rec.sorts.length; k++) if (rec.sorts[k].text) SORTS.push({ n: rec.sorts[k].text, v: rec.sorts[k].name || rec.sorts[k].text });
      }
    }
    var ft = _getJSON('https://m.douban.com/rexxar/api/v2/tv/recommend/filter_tags');
    if (ft && ft.tags && ft.tags.length > 0) {
      for (var t = 0; t < ft.tags.length; t++) {
        if (ft.tags[t].type === '地区' && ft.tags[t].tags && ft.tags[t].tags.length > 3) {
          TV_AREAS.length = 0;
          for (var a = 1; a < ft.tags[t].tags.length; a++) TV_AREAS.push(ft.tags[t].tags[a]);
        }
      }
    }
  } catch (e) {}
  SPIDER.filter.tvfilter = [
    { key: 1, name: '类型', value: _toOptions(TV_GENRES) },
    { key: 2, name: '电视剧', value: _toOptions(['全部','国产剧','港剧','台剧','日剧','韩剧','美剧','英剧','泰剧','海外剧']) },
    { key: 3, name: '综艺', value: _toOptions(['全部','国内综艺','国外综艺']) },
    { key: 4, name: '地区', value: _toOptions(TV_AREAS) },
    { key: 5, name: '年代', value: _toOptions(YEARS) },
    { key: 6, name: '平台', value: _toOptions(TV_PLATFORMS) },
    { key: 7, name: '标签', value: _toOptions(TV_TAGS) },
    { key: 8, name: '排序', value: SORTS }
  ];
}

function _toOptions(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push({ n: arr[i], v: arr[i] });
  return out;
}

function _init() {
  SPIDER.filter.hotmovie = [{ key: 1, name: '类型', value: _toOptions(['热门','最新','经典','可播放','豆瓣高分']) }];
  SPIDER.filter.hottv = [{ key: 1, name: '类型', value: _toOptions(['热门','最新','经典','可播放','豆瓣高分']) }];
  SPIDER.filter.hotzy = [{ key: 1, name: '分类', value: [{ n: '全部', v: '' }, { n: '国内', v: 'zy_cn' }, { n: '国外', v: 'zy_other' }] }];
  SPIDER.filter.movielist = [{ key: 1, name: '分类', value: [{ n: '实时热门', v: 'movie_real_time_hotest' }, { n: '一周口碑榜', v: 'movie_weekly_best' }] }];
  SPIDER.filter.tvlist = [{ key: 1, name: '分类', value: [{ n: '实时热门', v: 'tv_real_time_hotest' }, { n: '剧集热门', v: 'tv_hot' }] }];
  _initMovieFilter();
  _initTvFilter();
}

// ---------- 协议函数 ----------

function _initFn() {
  _init();
  return '';
}

function _home(filter) {
  var classes = [
    { type_id: 'hotmovie', type_name: '热门电影' },
    { type_id: 'hottv', type_name: '热门剧集' },
    { type_id: 'hotzy', type_name: '热门综艺' },
    { type_id: 'movielist', type_name: '电影榜单' },
    { type_id: 'tvlist', type_name: '电视榜单' },
    { type_id: 'moviefilter', type_name: '电影筛选' },
    { type_id: 'tvfilter', type_name: '电视筛选' }
  ];
  var out = { class: classes };
  if (filter) out.filters = SPIDER.filter;
  return JSON.stringify(out);
}

function _homeVod() {
  var d = _getJSON('https://m.douban.com/rexxar/api/v2/subject_collection/subject_real_time_hotest/items?start=0&count=50&updated_at=&items_only=1&for_mobile=1');
  var arr = [];
  if (d && d.subject_collection_items) {
    for (var i = 0; i < d.subject_collection_items.length; i++) {
      var m = _mapItem(d.subject_collection_items[i]);
      if (m) arr.push(m);
    }
  }
  return JSON.stringify({ list: arr });
}

function _category(tid, pg, filter, extend) {
  var page = parseInt(pg, 10);
  if (isNaN(page) || page < 1) page = 1;
  var per = 50;
  var base = 'https://m.douban.com/rexxar/api/v2/subject_collection/';
  var tail = 'items?updated_at=&items_only=1&for_mobile=1';
  var out;

  if (tid === 'hotmovie') {
    out = _mergeCollections([
      base + 'movie_real_time_hotest/' + tail + '&start=0&count=50',
      base + 'movie_weekly_best/' + tail + '&start=0&count=50'
    ], page);
  } else if (tid === 'hottv') {
    out = _mergeCollections([
      base + 'tv_real_time_hotest/' + tail + '&start=0&count=50',
      base + 'tv_hot/' + tail + '&start=0&count=50'
    ], page);
  } else if (tid === 'hotzy') {
    var sel = _ext(extend, 1, '');
    var d = _getJSON(base + 'show_hot/' + tail + '&start=0&count=100');
    var arr = [];
    if (d && d.subject_collection_items) {
      for (var i = 0; i < d.subject_collection_items.length; i++) {
        var it = d.subject_collection_items[i];
        if (!it) continue;
        var sub = it.card_subtitle || '';
        if (sel === 'zy_cn' && sub.indexOf('中国') === -1) continue;
        if (sel === 'zy_other' && sub.indexOf('中国') !== -1) continue;
        var m = _mapItem(it);
        if (m) arr.push(m);
      }
    }
    out = { list: arr, page: page, pagecount: 1, limit: per, total: arr.length };
  } else if (tid === 'movielist') {
    var mc = _ext(extend, 1, 'movie_real_time_hotest');
    out = _collection(base + mc + '/' + tail + '&start=' + ((page - 1) * per) + '&count=' + per, page, per);
  } else if (tid === 'tvlist') {
    var tc = _ext(extend, 1, 'tv_real_time_hotest');
    out = _collection(base + tc + '/' + tail + '&start=' + ((page - 1) * per) + '&count=' + per, page, per);
  } else if (tid === 'moviefilter') {
    var t1 = _ext(extend, 1, '');
    var t2 = _ext(extend, 2, '');
    var t3 = _ext(extend, 3, '');
    var t4 = _ext(extend, 4, '');
    var s1 = _ext(extend, 5, 'U');
    var selJson = encodeURI('{"类型":"' + t1 + '","地区":"' + t2 + '"}');
    var url = 'https://m.douban.com/rexxar/api/v2/movie/recommend?refresh=0&start=' + ((page - 1) * 20) + '&count=20&selected_categories=' + selJson + '&uncollect=false&sort=' + s1 + '&tags=' + _tags(t1, t2, t3, t4);
    out = _recommend(url, page, 'movie');
  } else if (tid === 'tvfilter') {
    var v1 = _ext(extend, 1, ''); // 类型
    var v2 = _ext(extend, 2, ''); // 电视剧
    var v3 = _ext(extend, 3, ''); // 综艺
    var v4 = _ext(extend, 4, ''); // 地区
    var v5 = _ext(extend, 5, ''); // 年代
    var v6 = _ext(extend, 6, ''); // 平台
    var v7 = _ext(extend, 7, ''); // 标签
    var v8 = _ext(extend, 8, 'U'); // 排序
    var fType = v1, fForm = '', fArea = v4;
    if (v1 === '电视剧') { fType = v1; fForm = v2; }
    else if (v1 === '综艺') { fType = v1; fForm = v3; }
    var selJson2 = encodeURI('{"类型":"' + fType + '","形式":"' + fForm + '","地区":"' + fArea + '"}');
    var url2 = 'https://m.douban.com/rexxar/api/v2/tv/recommend?refresh=0&start=' + ((page - 1) * 20) + '&count=20&selected_categories=' + selJson2 + '&uncollect=false&sort=' + v8 + '&tags=' + _tags(fType === '电视剧' ? fForm : fType, fArea, v5, v6, v7);
    out = _recommend(url2, page, 'tv');
  } else {
    out = { list: [], page: page, pagecount: 1, limit: per, total: 0 };
  }
  return JSON.stringify(out);
}

// ---------- 搜索：豆瓣 rexxar 搜索 + 合集直搜兜底 ----------
// 2026-09 加固四：豆瓣 rexxar 接口间歇性 403/空结果（实测"剑来 第三季"403、
// 裸词"剑来"200）。三级策略：
//   1. 豆瓣搜索
//   2. 空结果 → 去掉"第X季/部"和空格重试豆瓣（实测裸词能过）
//   3. 仍空 → 合集直搜：直接搜白名单内的合集源，详情页由对应源出片

function _cleanTitle(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function _doubanSearch(q) {
  var out = [];
  try {
    var d = _getJSON('https://m.douban.com/rexxar/api/v2/search?q=' + encodeURIComponent(q));
    if (d && d.subjects && d.subjects.items && d.subjects.items.length > 0) {
      for (var i = 0; i < d.subjects.items.length; i++) {
        var t = d.subjects.items[i].target;
        if (!t || !t.id) continue;
        var pic = t.cover_url || '';
        var rate = (t.rating && t.rating.value !== undefined && t.rating.value !== null) ? String(t.rating.value) : '暂无评分';
        out.push({ vod_id: String(t.id), vod_name: t.title || q, vod_pic: pic, vod_remarks: rate });
      }
    }
  } catch (e) {}
  return out;
}

// 合集直搜：逐源搜关键词，收集带标题的条目
// vod_id 格式 '源名|标识'：通用源=播放页路径，fetchLine源=标题
function _collectionSearch(wd) {
  var arr = [];
  var seen = {};
  function push(name, ident, title, pic) {
    title = _cleanTitle(title).replace(/^立刻播放/, '');
    if (!ident || !title || seen[title]) return;
    seen[title] = 1;
    arr.push({ vod_id: name + '|' + ident, vod_name: title, vod_pic: pic || '', vod_remarks: '合集·' + name });
  }
  var order = _srcOrder();
  for (var oi = 0; oi < order.length && arr.length < 12; oi++) {
    var src = SCAN_SOURCES[order[oi]];
    if (!合集绑定.hasOwnProperty(src.name)) continue;
    try {
      var sh = _req(src.search.replace('{q}', encodeURIComponent(wd)));
      if (!sh || sh.length < 400) continue;
      if (typeof src.fetchLine === 'function') {
        // 追光：voddetail 链接 + title 属性
        var re = /<a[^>]+href="\/voddetail\/(\d+)\.html"[^>]*title="([^"]*)"/g;
        var m, n = 0;
        while ((m = re.exec(sh)) !== null && n < 8) {
          n++;
          if (src.name === '七猫短剧') {
            var tm = /MTagBookList_bookName[^>]*>([^<]+)<\/a>/.exec(sh.substr(m.index, 800));
            if (tm) push(src.name, tm[1], tm[1]);
          } else {
            push(src.name, m[2], m[2]);
          }
        }
        continue;
      }
      if (!src.listRe) continue;
      src.listRe.lastIndex = 0;
      var m2, c = 0;
      while ((m2 = src.listRe.exec(sh)) !== null && c < 8) {
        c++;
        push(src.name, m2[1], m2[src.listTitleGroup || 2]);
      }
    } catch (e) {}
  }
  return arr;
}

function _search(wd, quick, pg) {
  var base = { page: 1, pagecount: 1, limit: 20 };
  if (!wd) return JSON.stringify({ list: [], page: 1, pagecount: 1, limit: 20, total: 0 });
  wd = String(wd);
  // 2026-09 加固五：quickSearch 常传来整页垃圾标题，如
  // "2026剧情片《抓特务》HD高清全集视频在线观看" —— 优先提取《书名号》内片名
  var mBk = wd.match(/《([^《》]{1,30})》/);
  var wdBk = mBk ? mBk[1].trim() : '';
  // 预处理：去掉季数后缀/空格/常见垃圾尾巴
  var wd2 = wd.replace(/第[一二三四五六七八九十\d]+[季部]/g, '')
              .replace(/(HD|全集|高清|在线观看|完整版|视频|剧情片|电视剧|第\d+集|预告|抢先看|国语|中字)/g, '')
              .replace(/\s+/g, '').trim();
  if (!wd2 && wdBk) wd2 = wdBk;
  // 1. 豆瓣（原词 → 书名号片名 → 裸词）
  var arr = _doubanSearch(wd);
  if (arr.length === 0 && wdBk && wdBk !== wd) arr = _doubanSearch(wdBk);
  if (arr.length === 0 && wd2 && wd2 !== wd) arr = _doubanSearch(wd2);
  // 2. 豆瓣全空 → 合集直搜（书名号片名 → 原词 → 裸词）
  if (arr.length === 0) {
    var tries = [];
    if (wdBk) tries.push(wdBk);
    tries.push(wd);
    if (wd2 && tries.indexOf(wd2) < 0) tries.push(wd2);
    var fb = [];
    for (var ti = 0; ti < tries.length && fb.length === 0; ti++) fb = _collectionSearch(tries[ti]);
    if (fb.length > 0) return JSON.stringify({ list: fb, page: 1, pagecount: 1, limit: 20, total: fb.length });
  }
  return JSON.stringify({ list: arr, page: base.page, pagecount: base.pagecount, limit: base.limit, total: arr.length });
}

// ---------- 详情：豆瓣 rexxar ----------
// 2026-09 加固四：合集直搜条目的详情——vod_id = '源名|标识'
// 通用源标识=播放页路径（直接抓播放页提 m3u8）；fetchLine源标识=标题（走其 fetchLine）

function _detailSource(id) {
  var p = String(id).split('|');
  if (p.length !== 2) return null;
  var sname = p[0], sid = p[1];
  var src = null;
  for (var i = 0; i < SCAN_SOURCES.length; i++) {
    if (SCAN_SOURCES[i].name === sname) { src = SCAN_SOURCES[i]; break; }
  }
  if (!src || !合集绑定[sname]) return null;
  var vod = { vod_id: sname + '|' + sid, vod_name: sid, vod_pic: '', vod_remarks: '', vod_content: '', vod_play_from: '', vod_play_url: '' };
  var m3u8 = '';
  try {
    if (typeof src.fetchLine === 'function') {
      var line = src.fetchLine(sid);
      if (line && line.url) m3u8 = line.url;
    } else {
      var pageUrl = src.play(sid);
      var ph = _req(pageUrl);
      if (ph && ph.length > 400) {
        src.m3u8Re.lastIndex = 0;
        var mm = src.m3u8Re.exec(ph);
        if (mm && mm[1]) m3u8 = mm[1].replace(/\\\//g, '/');
        var tm = /<title>([^<]{1,60})/.exec(ph);
        if (tm) vod.vod_name = _cleanTitle(tm[1].replace(/\s*[-–—].*$/, ''));
      }
    }
    // 直搜详情同样要验证 CDN——否则死 CDN 的线路会送到播放器无限转圈
    if (m3u8 && !_verifyM3u8(m3u8)) m3u8 = '';
  } catch (e) {}
  if (m3u8) {
    vod.vod_play_from = sname;
    vod.vod_play_url = '正片$' + m3u8;
    vod.vod_remarks = '合集·' + sname;
  }
  return JSON.stringify({ list: [vod] });
}

function _detail(id) {
  // 合集直搜条目（'源名|标识'）→ 由对应源出片
  if (String(id || '').indexOf('|') > -1) {
    var dsr = _detailSource(id);
    if (dsr) return dsr;
  }
  var vid = String(id || '').replace(/[^\d]/g, '');
  var vod = { vod_id: vid, vod_name: '', vod_pic: '', vod_actor: '', vod_director: '', vod_area: '', vod_year: '', vod_remarks: '', vod_content: '', vod_play_from: '', vod_play_url: '' };
  try {
    if (!vid) return JSON.stringify({ list: [] });
    var d = _getJSON('https://m.douban.com/rexxar/api/v2/movie/' + vid);
    if (!d || !d.title) d = _getJSON('https://m.douban.com/rexxar/api/v2/tv/' + vid);
    if (!d || !d.title) return JSON.stringify({ list: [vod] });

    var title = d.title || '';
    var pic = (d.pic && (d.pic.large || d.pic.normal)) || d.cover_url || '';
    var rate = (d.rating && d.rating.value !== undefined && d.rating.value !== null) ? String(d.rating.value) : '';
    var year = d.year ? String(d.year) : '';
    var directors = [];
    if (d.directors && d.directors.length) for (var i = 0; i < d.directors.length; i++) if (d.directors[i].name) directors.push(d.directors[i].name);
    var actors = [];
    if (d.actors && d.actors.length) for (var j = 0; j < d.actors.length; j++) if (d.actors[j].name) actors.push(d.actors[j].name);
    var areas = (d.countries && d.countries.length) ? d.countries.join(' ') : '';
    var genres = (d.genres && d.genres.length) ? d.genres.join(' ') : '';
    var intro = d.intro || '';
    var epInfo = d.episodes_info || '';
    var honor = '';
    if (d.honor_infos && d.honor_infos.length > 0 && d.honor_infos[0] && d.honor_infos[0].title) honor = d.honor_infos[0].title;

    var remarks = (rate && rate !== '0' && rate !== '0.0') ? rate : '';
    if (epInfo) remarks = remarks ? remarks + ' ' + epInfo : epInfo;
    if (!remarks && honor) remarks = honor;
    if (!remarks && year) remarks = year;

    vod.vod_name = title;
    vod.vod_pic = pic;
    vod.vod_actor = actors.slice(0, 8).join(' ');
    vod.vod_director = directors.slice(0, 3).join(' ');
    vod.vod_area = areas;
    vod.vod_year = year;
    vod.vod_remarks = remarks;
    vod.vod_content = intro;
    if (genres) vod.vod_type = genres;

    // 自动扫描：按片名扫订阅内其他源，把有播放页的源聚合为线路
    try {
      var lines = _scanTitle(title);
      if (lines && lines.length > 0) {
        var froms = [];
        var urls = [];
        for (var k = 0; k < lines.length; k++) {
          froms.push(lines[k].name);
          urls.push('正片$' + lines[k].url);
        }
        vod.vod_play_from = froms.join('$$$');
        vod.vod_play_url = urls.join('$$$');
      }
    } catch (e) {}
  } catch (e) {}
  return JSON.stringify({ list: [vod] });
}

// ---------- 自动扫描：订阅内其他源（播放线路聚合） ----------
//
// 每源一条：search 用 {q} 占位片名，re 提取搜索条目的播放页路径，
// play(path) 生成播放页 URL，m3u8Re 从播放页 HTML 里提取 m3u8 直链。
// 线路输出的是 m3u8 直链（壳子播放器直接可播，不走网页嗅探）。
// 新增源照格式加一条即可。
// 实测排除：腾讯/爱奇为官方源无法外部取链；奇优搜索走 POST（域名已
// 换到 qivod.com，CF 验证可能拦截）；七猫搜索无结果；4K 播放器为
// WASM 加密(nbmovie_wasm)取不到直链；兄弟(brovod.com)站点已失联；
// 枫叶搜索页结构不稳定且主站均在 Akamai 后面。

// ============================================================
// 扫描白名单：本 js 只扫描白名单内的源（对应 py/ 目录下的独立爬虫）。
// 不在表内的条目即使写进 SCAN_SOURCES 也一律不执行。
// 加/减扫描源：改 py/ 下对应爬虫后，同步改这张表。
// ============================================================
var 合集绑定 = {
  '视觉影院': '视觉',
  '毒舌影视': '毒舌',
  '追光影视': '追光',
  '七猫短剧': '七猫'
};

var SCAN_SOURCES = [
  {
    name: '视觉影院',
    search: 'https://www.sypfjy.com/vodsearch.html?wd={q}',
    re: /href="(\/vodplay\/\d+-1-1\.html)"[^>]*title="([^"]*)"/g,
    titleGroup: 2,
    play: function (p) { return 'https://www.sypfjy.com' + p; },
    m3u8Re: /"url":"(https?:\\?\/\\?\/[^"]+?\.m3u8[^"]*)"/g,
    // 合集直搜用：搜索页逐条收集（id组1=播放页路径, 组2=标题）
    listRe: /href="(\/vodplay\/\d+-1-1\.html)"[^>]*title="([^"]*)"/g,
    listTitleGroup: 2
  },
  {
    name: '毒舌影视',
    search: 'https://m.xnhrsb.com/dsshiyisc/{q}----------1---.html',
    re: /href="\/dsshiyidt\/(\d+)\.html"/g,
    titleGroup: 0,
    play: function (id) { return 'https://m.xnhrsb.com/dsshiyipy/' + id + '-1-1.html'; },
    m3u8Re: /"url":"(https?:\\?\/\\?\/[^"]+?\.m3u8[^"]*)"/g,
    // 合集直搜用：dsshiyidt 链接 + 后方 alt="标题"
    listRe: /href="\/dsshiyidt\/(\d+)\.html"[\s\S]{0,300}?alt="([^"]*)"/g,
    listTitleGroup: 2
  },
  // ---------- 实验性：自定义多步取线 ----------
  // fetchLine(title) 返回 {name,url} 或 null，走通用三步之外的多跳逻辑。
  // 追光影视 (top3.zgtv.online)：搜索→详情→逐线路试 player_aaaa，
  // 2026-09 实测其搜索接口间歇性 500/469/超时，属站点端抽风，
  // 家宽环境可能正常；失败静默跳过，不影响其它源。
  {
    name: '追光影视',
    fetchLine: function (title) {
      try {
        var HOST = 'https://top3.zgtv.online';
        // 1. 搜索 → 取标题匹配的详情页 id（无匹配则取第一条）
        var sh = _req(HOST + '/vodsearch/' + encodeURIComponent(title) + '-------------.html');
        if (!sh || sh.length < 400) return null;
        var re = /<a[^>]+href="\/voddetail\/(\d+)\.html"[^>]*title="([^"]*)"/g;
        var m = _matchItem(sh, re, 2, title);
        if (!m) { re.lastIndex = 0; m = /<a[^>]+href="\/voddetail\/(\d+)\.html"/.exec(sh); }
        if (!m) return null;
        var vid = m[1];
        // 2. 详情页 → 收集播放页路径（最多试 3 条线路，每线路取第1集）
        var dh = _req(HOST + '/voddetail/' + vid + '.html');
        if (!dh || dh.length < 400) return null;
        var pr = /href="\/vodplay\/(\d+)-(\d+)-(\d+)\.html"/g;
        var seenSids = {};
        var sids = [];
        var pm;
        while ((pm = pr.exec(dh)) !== null && sids.length < 4) {
          if (!seenSids[pm[2]]) { seenSids[pm[2]] = 1; sids.push(pm[2]); }
        }
        if (!sids.length) return null;
        // 3. 逐线路取 player_aaaa，拿到明文直链即成功
        for (var i = 0; i < sids.length; i++) {
          var ph = _req(HOST + '/vodplay/' + vid + '-' + sids[i] + '-1.html');
          if (!ph || ph.length < 400) continue;
          var um = /player_aaaa\s*=\s*\{[^}]*"url"\s*:\s*"([^"]+)"/.exec(ph);
          if (um && um[1]) {
            var u = um[1].replace(/\\\//g, '/');
            if (u.indexOf('.m3u8') > -1 || u.indexOf('.mp4') > -1) {
              return { name: this.name, url: u };
            }
          }
        }
        return null;
      } catch (e) { return null; }
    }
  },
  // 七猫短剧 (www.qmao.net)：搜索→详情→播放页 player_aaaa，
  // 2026-09 实测全链路通（短剧站点，线 from=360zy 等）
  {
    name: '七猫短剧',
    fetchLine: function (title) {
      try {
        var HOST = 'https://www.qmao.net';
        var sh = _req(HOST + '/vodsearch/-------------.html?wd=' + encodeURIComponent(title));
        if (!sh || sh.length < 400) return null;
        // 搜索条目：/voddetail/{id}.html 链接，标题在其后 800 字节内的
        // MTagBookList_bookName 里（对应 py 的 _extract_list 结构）
        var re = /href="\/voddetail\/(\d+)\.html"/g;
        var m, n = 0, first = null, matched = null;
        while ((m = re.exec(sh)) !== null && n < 8) {
          n++;
          if (!first) first = m;
          var tm = /MTagBookList_bookName[^>]*>([^<]+)<\/a>/.exec(sh.substr(m.index, 800));
          if (tm && tm[1] && _sim(tm[1], title)) { matched = m; break; }
        }
        m = matched || first;
        if (!m) return null;
        var vid = m[1];
        var ph = _req(HOST + '/vodplay/' + vid + '-1-1.html');
        if (!ph || ph.length < 400) return null;
        var pm = /var player_aaaa=(\{[^<]+\})/.exec(ph);
        if (pm) {
          try {
            var d = JSON.parse(pm[1]);
            var u = String(d.url || '');
            if (u.indexOf('http') === 0 && (u.indexOf('.m3u8') > -1 || u.indexOf('.mp4') > -1)) {
              return { name: this.name, url: u.replace(/\\\//g, '/') };
            }
          } catch (e2) {}
        }
        return null;
      } catch (e) { return null; }
    }
  }
];

// 标题相似度：去掉空白后互相包含即视为匹配
function _sim(a, b) {
  a = String(a || '').replace(/\s+/g, '');
  b = String(b || '').replace(/\s+/g, '');
  if (!a || !b) return false;
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

// 在 HTML 里用带 g 标志的正则循环找第一条"标题匹配"的条目
function _matchItem(html, re, titleGroup, title) {
  var m = null;
  var n = 0;
  re.lastIndex = 0;
  while ((m = re.exec(html)) !== null) {
    n++;
    if (n > 10) break;
    if (!titleGroup) return m; // 不校验标题，取第一条
    var got = m[titleGroup];
    if (got && _sim(got, title)) return m;
  }
  return null;
}

var _SCAN_CACHE = {};

// 2026-09 加固三：谁快先用谁。
// 记录每个源的历史耗时/命中率，扫描按"最快的源先试"排序；
// 拿到第一条经验证的直链就立刻返回，不再等其余源扫完。
// （JS 引擎是同步单线程，做不到真并发——靠"学习排序+命中即停"达到同样效果）
var _SRC_STATS = {};

function _srcOrder() {
  var idx = [];
  for (var i = 0; i < SCAN_SOURCES.length; i++) idx.push(i);
  idx.sort(function (a, b) {
    var sa = _SRC_STATS[SCAN_SOURCES[a].name] || { n: 0, ms: 0, ok: 0 };
    var sb = _SRC_STATS[SCAN_SOURCES[b].name] || { n: 0, ms: 0, ok: 0 };
    // 平均耗时升序；从未测过的源排最前（未知源优先给它机会）
    var va = sa.n ? sa.ms / sa.n : 0;
    var vb = sb.n ? sb.ms / sb.n : 0;
    return va - vb;
  });
  return idx;
}

// 直链可达性验证：轻量拉一次 m3u8，死 CDN 当场淘汰
// （实测 yddsha2/qrssv 这类半死 CDN：ConnectException / TLS 握手被掐）
function _verifyM3u8(u) {
  try {
    var vh = _req(u);
    return vh && vh.length > 30 && vh.indexOf('#EXTM3U') > -1;
  } catch (e) { return false; }
}

// 按片名扫描各源，返回 [{name, url}]（url 为 m3u8 直链）
// 2026-09 改版：最快命中的源直接返回（1 条线路），后续调用由缓存秒回
function _scanTitle(title) {
  if (!title) return [];
  var key = 's:' + title;
  if (_SCAN_CACHE[key]) return _SCAN_CACHE[key];
  var results = [];
  var hit = false;
  var order = _srcOrder();
  for (var oi = 0; oi < order.length && !hit; oi++) {
    var i = order[oi];
    var src = SCAN_SOURCES[i];
    // 合集绑定：只执行 py/合集.py 白名单内的源
    if (!合集绑定.hasOwnProperty(src.name)) continue;
    var st = _SRC_STATS[src.name] || (_SRC_STATS[src.name] = { n: 0, ms: 0, ok: 0 });
    var t0 = Date.now();
    try {
      // 自定义多步取线（追光/七猫等）优先
      if (typeof src.fetchLine === 'function') {
        var line = src.fetchLine(title);
        if (line && line.url && _verifyM3u8(line.url)) {
          results.push({ name: line.name || src.name, url: line.url });
          hit = true;
        }
        continue;
      }
      var url = src.search.replace('{q}', encodeURIComponent(title));
      var html = _req(url);                       // 1. 搜索页
      if (!html || html.length < 400) continue;
      var m = _matchItem(html, src.re, src.titleGroup || 0, title);
      if (!m) continue;
      var pageUrl = src.play(m[1]);               // 2. 播放页
      var ph = _req(pageUrl);
      if (!ph || ph.length < 400) continue;
      src.m3u8Re.lastIndex = 0;
      var mm = src.m3u8Re.exec(ph);               // 3. 提取 m3u8 直链
      if (!mm || !mm[1]) continue;
// 2026-09 加固二：扫到直链后先验证 CDN 可达（发一次轻量请求），
// 避免把死 CDN 的线路推给播放器无限转圈（实测 yddsha2/qrssv 这类半死 CDN）
      var real = mm[1].replace(/\\\//g, '/');
      if (real && _verifyM3u8(real)) {
        results.push({ name: src.name, url: real });
        hit = true;
      }
    } catch (e) {
    } finally {
      st.n++;
      st.ms += (Date.now() - t0);
      if (hit) st.ok++;
    }
  }
  _SCAN_CACHE[key] = results;
  return results;
}

// ---------- 播放：忠实原版（不内置任何第三方播放源） ----------

function _play(flag, id, flags) {
  return JSON.stringify({
    parse: '0',
    jx: '0',
    headers: '',
    playUrl: '',
    url: String(id || '')
  });
}

// ---------- 导出 ----------

__JS_SPIDER__ = {
  init: _initFn,
  home: _home,
  homeVod: _homeVod,
  category: _category,
  detail: _detail,
  play: _play,
  search: _search
};