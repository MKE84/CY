// ============================================================
// 云海.js —— 豆瓣影视聚合源 v2（全新重构版）
// ------------------------------------------------------------
// 协议：__JS_SPIDER__（TVBox / WebHTV 通用 JS 源）
// 浏览/搜索/详情：m.douban.com rexxar API（热门/榜单/筛选/搜索/详情）
// 播放线路：自动扫描白名单内的 py 爬虫源（SCAN_BINDING 强制约束）
//
// v2 特性（全部实测通过）：
//   1. 三级搜索降级：豆瓣 → 裸词重试（去季数/书名号提取/垃圾词清洗）
//      → 源站直搜（搜出来就能直接播）
//   2. 直链可达性验证：扫到的 m3u8 先验 CDN，死链当场淘汰
//   3. 最快命中：按各源历史耗时学习排序，命中即返回，不傻等全源扫完
//   4. 白名单强制：SCAN_SOURCES 里不在 SCAN_BINDING 表内的条目不执行
//   5. 全请求 6s 超时 + try/catch 空值保护
//   8. v8: 豆瓣挂掉自愈 —— 连续3次失败后5分钟内跳过豆瓣全部请求
//      （搜索直奔源站直搜、封面不再逐条白等超时），首页自动降级到源站热榜
//   6. v4：白名单扩到 7 源（视觉/毒舌/追光/七猫/八天/多瑙/爱壹帆），
//      m3u8 验证 3.5s 超时 + URL 级缓存，历史 100% 命中的源跳过握手验证；
//      多瑙一次 API 返回多条线路，爱壹帆/八天为标准 player_aaaa 结构
//
// 内容合规：配套 py 源已经过审核，成人/18+ 站点及分类已全部剔除
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
      var r = req(url, { headers: SPIDER.headers, timeout: 4500 });
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
  var start = (page > 1 ? page - 1 : 0) * 50;
  for (var c = 0; c < cols.length; c++) {
    var d = _getJSON(cols[c].replace(/start=\d+/, 'start=' + start));
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

function _homeVodFallback() {
  var arr = [];
  var seen = {};
  var order = _srcOrder().slice(0, 5);
  for (var oi = 0; oi < order.length && arr.length < 20; oi++) {
    var src = SCAN_SOURCES[order[oi]];
    if (!SCAN_BINDING.hasOwnProperty(src.name)) continue;
    if (!src.listRe && !src.homeRe) continue;
    var lre = src.homeRe || src.listRe;
    try {
      var homeUrl = src.home || (String(src.search).split('?')[0].replace(/[^\/]*$/, ''));
      var html = _req(homeUrl);
      if (!html || html.length < 400) continue;
      lre.lastIndex = 0;
      var m2, c2 = 0;
      while ((m2 = lre.exec(html)) !== null && c2 < 8) {
        c2++;
        var t = _cleanTitle(m2[src.listTitleGroup || 2]).replace(/^立刻播放/, '');
        if (!t || seen[t]) continue;
        seen[t] = 1;
        arr.push({ vod_id: src.name + '|' + m2[1], vod_name: t, vod_pic: '', vod_remarks: '直搜·' + src.name });
      }
    } catch (e) {}
  }
  return arr;
}

function _homeVod() {
  var d = _getJSON('https://m.douban.com/rexxar/api/v2/subject_collection/subject_real_time_hotest/items?start=0&count=50&updated_at=&items_only=1&for_mobile=1');
  if (!d) _dbFail();
  var arr = [];
  if (d && d.subject_collection_items) {
    _DB_STATE.fails = 0;
    for (var i = 0; i < d.subject_collection_items.length; i++) {
      var m = _mapItem(d.subject_collection_items[i]);
      if (m) arr.push(m);
    }
  }
  // v8: 豆瓣挂着 → 源站首页兜底（界面不再空白）
  if (arr.length === 0 && _doubanDown()) {
    var fb = _homeVodFallback();
    if (fb.length) return JSON.stringify({ list: fb });
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

// ---------- 搜索：豆瓣 rexxar 搜索 + 源站直搜兜底 ----------
// 2026-09 加固四：豆瓣 rexxar 接口间歇性 403/空结果（实测"剑来 第三季"403、
// 裸词"剑来"200）。三级策略：
//   1. 豆瓣搜索
//   2. 空结果 → 去掉"第X季/部"和空格重试豆瓣（实测裸词能过）
//   3. 仍空 → 源站直搜：直接搜白名单内的爬虫源，详情页由对应源出片

function _cleanTitle(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

var _DOUBAN_CACHE = {};
// v8: 豆瓣可达性状态机 —— 连续3次网络级失败后，5分钟内跳过一切豆瓣请求
// （豆瓣接口挂着时，每个兜底封面查询都要白等 4.5s 超时，整包卡死的元凶）
var _DB_STATE = { fails: 0, downUntil: 0 };
function _doubanDown() { return Date.now() < _DB_STATE.downUntil || _DB_STATE.fails >= 3; }
function _dbFail() { _DB_STATE.fails++; if (_DB_STATE.fails >= 3) _DB_STATE.downUntil = Date.now() + 300000; }
function _dbGood() { _DB_STATE.fails = 0; }

function _doubanSearch(q) {
  var out = [];
  var ck = 'ds:' + q;
  if (_DOUBAN_CACHE[ck] !== undefined) {
    try { return JSON.parse(_DOUBAN_CACHE[ck]); } catch (e0) { return []; }
  }
  try {
    var d = _getJSON('https://m.douban.com/rexxar/api/v2/search?q=' + encodeURIComponent(q));
    if (!d) { _dbFail(); _DB_STATE.downUntil = Date.now() + 60000; }
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
  if (out.length > 0) {
    try { _DOUBAN_CACHE[ck] = JSON.stringify(out); } catch (e1) {}
  }
  return out;
}

// 源站直搜：逐源搜关键词，收集带标题的条目
// vod_id 格式 '源名|标识'：通用源=播放页路径，fetchLine源=标题
// 2026-09-20 v7: 直搜结果封面兜底——查豆瓣同名片拿 poster（缓存按片名）
var _DOUBAN_PIC_CACHE = {};
function _doubanPicOf(title) {
  if (!title) return '';
  if (_doubanDown()) return '';   // v8: 豆瓣挂着时不再逐条白等超时
  if (_DB_STATE.fails >= 2) return '';
  var ck = 'p:' + title;
  if (_DOUBAN_PIC_CACHE[ck] !== undefined) return _DOUBAN_PIC_CACHE[ck];
  var pic = '';
  try {
    var d = _getJSON('https://m.douban.com/rexxar/api/v2/search?q=' + encodeURIComponent(title));
    if (d && d.subjects && d.subjects.items && d.subjects.items.length > 0) {
      for (var i = 0; i < d.subjects.items.length; i++) {
        var t = d.subjects.items[i].target;
        if (!t || !t.id || !t.title) continue;
        if (_sim(t.title, title)) {
          if (t.cover_url) { _DOUBAN_PIC_CACHE[ck] = t.cover_url; return t.cover_url; }
        }
      }
    }
  } catch (e) {}
  _DOUBAN_PIC_CACHE[ck] = '';
  return '';
}

function _collectionSearch(wd) {
  var arr = [];
  var seen = {};
  function push(name, ident, title, pic) {
    title = _cleanTitle(title).replace(/^立刻播放/, '');
    if (!ident || !title || seen[title]) return;
    seen[title] = 1;
    // 2026-09-20 v7 封面兜底：源站没抓到海报 → 豆瓣同名片封面（缓存查询）
    if (!pic) pic = _doubanPicOf(title);
    arr.push({ vod_id: name + '|' + ident, vod_name: title, vod_pic: pic || '', vod_remarks: '直搜·' + name });
  }
  var order = _srcOrder().slice(0, 4);
  for (var oi = 0; oi < order.length && arr.length < 12; oi++) {
    var src = SCAN_SOURCES[order[oi]];
    if (!SCAN_BINDING.hasOwnProperty(src.name)) continue;
    try {
      var sh = _req(src.search.replace('{q}', encodeURIComponent(wd)));
      if (!sh || sh.length < 400) continue;
      if (typeof src.fetchLine === 'function') {
        // 追光：voddetail 链接 + 邻近 title（锚点本身不带 title 属性，2026-09 实测）
        var re = /<a[^>]+href="\/voddetail\/(\d+)\.html"([\s\S]{0,900}?[\s](?:title|alt)="([^"]*)")?/g;
        var m, n = 0;
        while ((m = re.exec(sh)) !== null && n < 8) {
          n++;
          if (src.name === '七猫短剧') {
            var tm = /MTagBookList_bookName[^>]*>([^<]+)<\/a>/.exec(sh.substr(m.index, 800));
            if (tm) push(src.name, tm[1], tm[1]);
          } else if (m[3]) {
            push(src.name, m[1] + '.html', m[3]);
          }
        }
        continue;
      }
      if (!src.listRe) continue;
      src.listRe.lastIndex = 0;
      var m2, c = 0;
      while ((m2 = src.listRe.exec(sh)) !== null && c < 8) {
        c++;
        // 2026-09-20 封面：条目锚点前后窗口内的 poster img（逐条对齐）
        var pic = '';
        if (src.picRe) {
          var win = sh.slice(Math.max(0, m2.index - 900), m2.index + 900);
          var pm = src.picRe.exec(win);
          if (pm && pm[1]) pic = (src.picBase || '') + pm[1];
        }
        push(src.name, m2[1], m2[src.listTitleGroup || 2], pic);
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
  // 1. 豆瓣（原词 → 书名号片名 → 裸词）—— v8: 豆瓣挂着时全部跳过
  var arr = _doubanDown() ? [] : _doubanSearch(wd);
  if (arr.length === 0 && !_doubanDown() && wdBk && wdBk !== wd) arr = _doubanSearch(wdBk);
  if (arr.length === 0 && !_doubanDown() && wd2 && wd2 !== wd) arr = _doubanSearch(wd2);
  // 2. 豆瓣全空 → 源站直搜（书名号片名 → 原词 → 裸词）
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
// 2026-09 加固四：源站直搜条目的详情——vod_id = '源名|标识'
// 通用源标识=播放页路径（直接抓播放页提 m3u8）；fetchLine源标识=标题（走其 fetchLine）

function _detailSource(id) {
  var p = String(id).split('|');
  if (p.length !== 2) return null;
  var sname = p[0], sid = p[1];
  var src = null;
  for (var i = 0; i < SCAN_SOURCES.length; i++) {
    if (SCAN_SOURCES[i].name === sname) { src = SCAN_SOURCES[i]; break; }
  }
  if (!src || !SCAN_BINDING[sname]) return null;
  var vod = { vod_id: sname + '|' + sid, vod_name: sid, vod_pic: '', vod_remarks: '', vod_content: '', vod_play_from: '', vod_play_url: '' };
  var m3u8 = '';
  try {
    if (typeof src.fetchLine === 'function') {
      var line = src.fetchLine(sid);
      if (line && line.url) m3u8 = line.url;
    } else if (src.epsPage && src.epPlay && src.epsRe) {
      // v7 效率优先：直接从详情页取剧集列表，第1集即 m3u8 —— 少 1 次播放页请求
      var epsList0 = _episodes(src, sid);
      if (epsList0.length > 0) {
        var firstEp = epsList0[0];
        var firstUrl = src.epPlay(firstEp.path);
        var ph0 = _req(firstUrl) || '';
        if (ph0.length > 400) {
          src.m3u8Re.lastIndex = 0;
          var mm0 = src.m3u8Re.exec(ph0);
          if (mm0 && mm0[1]) m3u8 = mm0[1].replace(/\\\//g, '/');
        }
      }
    } else {
      var sid2 = String(sid);
      var pageUrl = src.play(sid2);
      if (sid2.indexOf('voddetail') > -1 && src.home) {
        // 首页兜底条目：标识是详情页路径 → 先抓详情找首个播放页
        var dhtml = _req(src.home + sid2.replace(/^\//, '')) || '';
        var pm2 = /href="\/vodplay\/\d+-\d+-\d+\.html"/.exec(dhtml);
        if (pm2) pageUrl = src.home + pm2[0].replace('href="', '').replace('"', '');
      }
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
    // 2026-09-20 v7 铁律：首次命中立即返回。所有集数走 EP:: lazy，
    // 首集 m3u8 已在上面抓过 —— detail() 秒回，播放时才解析其他集
    if (src && src.epsPage && src.epPlay) {
      var epsList = _episodes(src, sid);
      if (epsList.length > 1) {
        var eUrls = [];
        for (var ek = 0; ek < epsList.length; ek++) {
          var e = epsList[ek];
          // 首集 = 已抓到的 m3u8；其余 EP:: 播放时解析（0 额外请求）
          if (ek === 0 && m3u8) eUrls.push(e.ep + '$' + m3u8);
          else eUrls.push(e.ep + '$EP::' + sname + '::' + e.path);
        }
        if (eUrls.length) {
          vod.vod_play_from = sname;
          vod.vod_play_url = eUrls.join('#');
          vod.vod_remarks = '直搜·' + sname;
          return JSON.stringify({ list: [vod] });
        }
      }
    }
  if (m3u8) {
    vod.vod_play_from = sname;
    vod.vod_play_url = '正片$' + m3u8;
    vod.vod_remarks = '直搜·' + sname;
  }
  return JSON.stringify({ list: [vod] });
}

function _detail(id) {
  // 源站直搜条目（'源名|标识'）→ 由对应源出片
  if (String(id || '').indexOf('|') > -1) {
    var dsr = _detailSource(id);
    if (dsr) return dsr;
  }
  var vid = String(id || '').replace(/[^\d]/g, '');
  var vod = { vod_id: vid, vod_name: '', vod_pic: '', vod_actor: '', vod_director: '', vod_area: '', vod_year: '', vod_remarks: '', vod_content: '', vod_play_from: '', vod_play_url: '' };
  try {
    if (!vid) return JSON.stringify({ list: [] });
    // 2026-09-20 v7: 豆瓣详情缓存（同一 vid 二次进入秒出）
    var dCache = _DOUBAN_CACHE['dv:' + vid];
    var d = null;
    if (dCache !== undefined) {
      try { d = JSON.parse(dCache); } catch (e0) { d = null; }
    }
    if (!d) {
      d = _getJSON('https://m.douban.com/rexxar/api/v2/movie/' + vid);
      if (!d || !d.title) d = _getJSON('https://m.douban.com/rexxar/api/v2/tv/' + vid);
      if (d && d.title) {
        try { _DOUBAN_CACHE['dv:' + vid] = JSON.stringify(d); } catch (e1) {}
      }
    }
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
        // 2026-09 加固七：整词扫描失败时用“去季数/去空格”的变体重扫——
        // 源站常收录的是不带季数的基础片名（如“剑来”而非“剑来 第三季”）
        if ((!lines || lines.length === 0) && title) {
          var t2 = String(title).replace(/第[一二三四五六七八九十\d]+[季部]/g, '').replace(/\s+/g, '').trim();
          if (t2 && t2 !== title) lines = _scanTitle(t2);
        }
      if (lines && lines.length > 0) {
        var froms = [];
        var urls = [];
        for (var k = 0; k < lines.length; k++) {
          var ln = lines[k];
          var src = null;
          for (var si = 0; si < SCAN_SOURCES.length; si++) {
            if (SCAN_SOURCES[si].name === ln.name) { src = SCAN_SOURCES[si]; break; }
          }
          // 2026-09-20 封面兜底：豆瓣封面挂了 → 用源站搜索页拿到的海报
          if (!vod.vod_pic && ln.pic) vod.vod_pic = ln.pic;
          // 2026-09-20 修复"永远只有正片"：当源支持集数枚举并命中 >1 时按集输出
          if (src && src.epsPage && src.epPlay && ln.ident) {
            var epsList = _episodes(src, ln.ident);
            if (epsList.length > 1) {
              var eUrls = [];
              for (var ei = 0; ei < epsList.length; ei++) {
                var e = epsList[ei];
                var pu = '';
                if (ei === 0 && ln.url) {
                  // 首集复用 _scanTitle 已缓存的真实 m3u8 —— 秒出
                  pu = ln.url;
                } else {
                  // v7 铁律：detail 页面只给 EP:: lazy 占位，不预抓。
                  // 每集播放时 _play 按需解析——详情页 0 额外请求
                  eUrls.push(e.ep + '$EP::' + ln.name + '::' + e.path);
                  continue;
                }
                if (pu) eUrls.push(e.ep + '$' + pu);
              }
              if (eUrls.length) { froms.push(ln.name); urls.push(eUrls.join('#')); continue; }
            }
          }
          froms.push(ln.name);
          urls.push('正片$' + ln.url);
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
var SCAN_BINDING = {
  '视觉影院': '视觉',
  '毒舌影视': '毒舌',
  '追光影视': '追光',
  '七猫短剧': '七猫',
  '八天电影': '八天电影',
  '多瑙影院': '多瑙影院',
  '爱壹帆影视': '爱壹帆'
};

var SCAN_SOURCES = [
  {
    name: '视觉影院',
    search: 'https://www.sypfjy.com/vodsearch.html?wd={q}',
    home: 'https://www.sypfjy.com/',
    homeRe: /href="(\/voddetail\/\d+\.html)"[\s\S]{0,600}?alt="([^"]{1,40})"/g,
    re: /href="(\/vodplay\/\d+-1-1\.html)"[^>]*title="([^"]*)"/g,
    titleGroup: 2,
    play: function (p) { return 'https://www.sypfjy.com' + p; },
    m3u8Re: /"url":"(https?:\\?\/\\?\/[^"]+?\.m3u8[^"]*)"/g,
    // 源站直搜用：搜索页逐条收集（id组1=播放页路径, 组2=标题）
    listRe: /href="(\/vodplay\/\d+-1-1\.html)"[^>]*title="([^"]*)"/g,
    listTitleGroup: 2,
    epsPage: function (ident) {
      var dd = /vodplay\/(\d+)-/.exec(String(ident));
      return dd ? 'https://www.sypfjy.com/voddetail/' + dd[1] + '.html' : null;
    },
      epsRe: /href="(\/vodplay\/\d+-\d+-\d+\.html)"[^>]*title="([^"]{1,40})"/g,
      epPlay: function (path) { return 'https://www.sypfjy.com' + path; },
      // 2026-09-20 搜索结果封面：搜索页条目里的 poster img
      picRe: /data-src="(https?:[^"\s]+\.(?:jpg|png|webp))"/,
      picBase: ''
    },
  {
    name: '毒舌影视',
    search: 'https://m.xnhrsb.com/dsshiyisc/{q}----------1---.html',
    home: 'https://m.xnhrsb.com/',
    re: /href="\/dsshiyidt\/(\d+)\.html"/g,
    titleGroup: 0,
    play: function (id) { return 'https://m.xnhrsb.com/dsshiyipy/' + id + '-1-1.html'; },
    m3u8Re: /"url":"(https?:\\?\/\\?\/[^"]+?\.m3u8[^"]*)"/g,
    // 源站直搜用：dsshiyidt 链接 + 后方 alt="标题"
    listRe: /href="\/dsshiyidt\/(\d+)\.html"[\s\S]{0,300}?alt="([^"]*)"/g,
    epsPage: function (ident) {
      var dd = /(\d+)/.exec(String(ident));
      return dd ? 'https://m.xnhrsb.com/dsshiyidt/' + dd[1] + '.html' : null;
    },
    epsRe: /href="(\/dsshiyipy\/\d+-\d+-\d+\.html)"[^>]*>([^<]{1,16})</g,
    epPlay: function (path) { return 'https://m.xnhrsb.com' + path; },
    picRe: /data-original="([^"\s]+\.(?:jpg|png|webp))"/,
    picBase: 'https://m.xnhrsb.com'
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
        // 实测（2026-09）：页面 voddetail 锚点本身不带 title 属性，标题在
        // 后续兄弟节点里 —— 先试宽松表达式（链接后 800 字节内找 title=），
        // 不命中再退回第一条链接
        var re1 = /<a[^>]+href="\/voddetail\/(\d+)\.html"([\s\S]{0,900}?[\s](?:title|alt)="([^"]*)")?/g;
        var m = _matchItem(sh, re1, 3, title);
        if (!m) { re1.lastIndex = 0; m = /<a[^>]+href="\/voddetail\/(\d+)\.html"/.exec(sh); }
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
  },
    // ---------- 2026-09-20 新增（实测全链路通过）----------
    // 八天电影 (dy.8ttv.cn)：三步=搜索→详情→播放页（player_aaaa.url）
    {
      name: '八天电影',
      search: 'https://dy.8ttv.cn/index.php/vod/search/wd/{q}.html',
      home: 'https://dy.8ttv.cn/',
      re: /href="(\/index\.php\/vod\/detail\/id\/\d+\.html)"/g,
      titleGroup: 0,
      play: function (p) {
        var u = String(p);
        if (u.indexOf('/index.php/vod/play/') === 0) return 'https://dy.8ttv.cn' + u;  // 已是播放路径
        return 'https://dy.8ttv.cn/index.php/vod/play/id/' + u + '/sid/1/nid/1.html';
      },
      m3u8Re: /player_aaaa\s*=\s*\{[\s\S]{0,2500}?"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
      listRe: /href="\/index\.php\/vod\/detail\/id\/(\d+)\.html"[\s\S]{0,900}?[\s](?:title|alt)="([^"]{1,40})"/g,
      listTitleGroup: 2,
      epsPage: function (ident) {
        var dd = /detail\/id\/(\d+)\.html/.exec(String(ident));
        return dd ? 'https://dy.8ttv.cn/index.php/vod/detail/id/' + dd[1] + '.html' : null;
      },
      epsRe: /href="(\/index\.php\/vod\/play\/id\/\d+\/sid\/\d+\/nid\/\d+\.html)"[^>]*title="([^"]{1,40})"/g,
      epPlay: function (path) { return 'https://dy.8ttv.cn' + path; },
      picRe: /data-original="(https?:[^"\s]+\.(?:jpg|png|webp))"/,
      picBase: ''
    },
    // 多瑙影院 (dnvod.org)：/search?wd= → /anime|doc|.../detail/{id} →
    // /vod_plays/{id}/{ep} 返回 JSON 数组含多条 m3u8（一次请求多条线路）
    {
      name: '多瑙影院',
      fetchLine: function (title) {
        try {
          var HOST = 'https://dnvod.org';
          var sh = _req(HOST + '/search?q=' + encodeURIComponent(title));
          if (!sh || sh.length < 400) return null;
          var re = /href="\/(anime|doc|movie|show|tv)\/detail\/(\d+)"/g;
          // 2026-09-20 升级：search 页是"detail 链接 → 窗口(1800字) → 标题div"结构。
          // 逐条扫描所有 detail 链接，在窗口里找标题；sim 匹配即取该 id。
          var reTitle = /<div[^>]+class=["'][^"']*text-left\s+text-truncate\s+text-dark[^"']*["'][^>]*>([\s\S]{1,60}?)<\/div>/g;
          var matches = [];
          var tmp = null;
          re.lastIndex = 0;
          while ((tmp = re.exec(sh)) !== null) {
            matches.push({ id: tmp[2], cat: tmp[1], idx: tmp.index });
          }
          var vid = null, cat = null, hitTitle = null;
          for (var mi = 0; mi < matches.length; mi++) {
            var win = sh.slice(matches[mi].idx, matches[mi].idx + 1800);
            var tw = null;
            reTitle.lastIndex = 0;
            while ((tw = reTitle.exec(win)) !== null) {
              var tn = tw[1].replace(/<[^>]*>/g, '').trim();
              if (_sim(tn, title)) { vid = matches[mi].id; cat = matches[mi].cat; hitTitle = tn; break; }
            }
            if (vid) break;
          }
          if (!vid) { re.lastIndex = 0; var first = re.exec(sh); if (first) { vid = first[2]; cat = first[1]; } }
          if (!vid) return null;
          var m = [null, null, vid];
          // 2026-09-20: 需要 ep 标记 —— 详情页 /play/{vid}-epXXX（电视）或 -m（电影）。
          var dhDetail = _req(HOST + '/' + cat + '/detail/' + vid) || '';
          var ep = null;
          var pm = /href="\/play\/\d+-([\w]+)"/.exec(dhDetail);
          if (pm) ep = pm[1];
          if (!ep) ep = 'm';
          var dh = _req(HOST + '/vod_plays/' + vid + '/' + ep);
          if (!dh || dh.length < 100) return null;
          var jd = JSON.parse(dh);
          var plays = jd.video_plays || [];
          for (var i = 0; i < plays.length; i++) {
            var u = String(plays[i].play_data || '');
            if (u.indexOf('.m3u8') > -1 || u.indexOf('.mp4') > -1) {
              return { name: this.name, url: u.replace(/\\\//g, '/') };
            }
          }
          return null;
        } catch (e) { return null; }
      }
    },
    // 爱壹帆 (iyf.lv)：iyfplay 页面标准 player_aaaa.url（m3u8 明文）
    {
      name: '爱壹帆影视',
      search: 'https://www.iyf.lv/s/{q}-------------.html',
      home: 'https://www.iyf.lv/',
      play: function (idRaw) { return 'https://www.iyf.lv/iyfplay/' + idRaw + '/'; },
      m3u8Re: /player_aaaa\s*=\s*\{[\s\S]{0,2500}?"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
      listRe: /href="\/iyfplay\/(\d+-1-1)\/"[\s\S]{0,1200}?alt="([^"]{1,40})"/g,
      epsPage: function (ident) {
        var ai = /(\d+)-1-1/.exec(String(ident));
        return ai ? 'https://www.iyf.lv/iyftv/' + ai[1] + '/' : null;
      },
      epsRe: /href="(\/iyfplay\/\d+-\d+-\d+)\/"[^>]*title="([^"]{1,40})"/g,
      epPlay: function (path) { return 'https://www.iyf.lv' + path + '/'; },
      picRe: /data-original="([^"\s]+\.(?:jpg|png|webp))"/,
      picBase: 'https://www.iyf.lv'
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

// 2026-09-20 v7 铁律："谁最快就用谁"——按 历史命中优先 + 平均耗时升序
// 打分: score = (ok===0 ? 9999 : ms/n) ; 未测过的排最前
function _srcOrder() {
  var idx = [];
  for (var i = 0; i < SCAN_SOURCES.length; i++) idx.push(i);
  idx.sort(function (a, b) {
    function score(nm) {
      var st = _SRC_STATS[nm];
      if (!st || st.n === 0) return -1;         // 未测过的最先试
      if (st.ok === 0) return 99999;            // 试过全失败的垫底
      return st.ms / st.n;                      // 平均耗时
    }
    var va = score(SCAN_SOURCES[a].name);
    var vb = score(SCAN_SOURCES[b].name);
    return va - vb;
  });
  return idx;
}

// 直链可达性验证
// 2026-09-20 加速：原实现读整个 m3u8 + 默认 6s 超时，慢 CDN（如 maowushi
// 首包 6s）白拖 6 秒。改为 3.5 秒超时轻量请求；并把结果按 URL 缓存，
// 同一直链复查秒回。
var _verifyCache = {};
var _EP_CACHE = {};      // src.name|ident → [{ep, path}]
var _EP_M3U8_CACHE = {};  // src.name|ident|ep → m3u8 URL
// 2026-09-20 v7：真值永久缓存；失败记录时间戳，60 秒后允许重试。
// （原永久 false 缓存导致 CDN 恢复后也拿不到线路——"时好时坏"主因）
var _VERIFY_TTL = 60000;
function _verifyM3u8(u) {
  if (!u) return false;
  var rec = _verifyCache[u];
  if (rec !== undefined) {
    if (rec === true) return true;
    if (Date.now() - rec < _VERIFY_TTL) return false;  // 失败缓存 60s 内直接跳过
  }
  var ok = false;
  try {
    if (typeof req === 'function') {
      var vh = req(u, { headers: SPIDER.headers, timeout: 3500 });
      var c = (vh && vh.content) ? vh.content : '';
      ok = !!(c && c.length > 30 && c.indexOf('#EXTM3U') > -1);
    } else {
      var vh2 = _req(u);
      ok = !!(vh2 && vh2.length > 30 && vh2.indexOf('#EXTM3U') > -1);
    }
  } catch (e) { ok = false; }
  _verifyCache[u] = ok ? true : Date.now();
  return ok;
}

// 各线路域名的防盗链请求头（播放器需要带上才能过 CDN 防盗链）
var _PLAY_HEADERS = {};
function _playHeadersFor(u) {
  try {
    var m = /^https?:\/\/([^\/]+)/.exec(String(u || ''));
    if (!m) return '';
    var host = m[1];
    // 已知需要 Referer 的 CDN：iappcht／baidu／bilibili 等按需追加
    var refRules = [
      { match: 'yuglf.com', ref: 'https://www.sypfjy.com/' },
      { match: 'hkzy.vip', ref: 'https://m.xnhrsb.com/' },
      { match: 'zgtv.online', ref: 'https://top3.zgtv.online/' },
      { match: 'qmao.net', ref: 'https://www.qmao.net/' }
    ];
    for (var i = 0; i < refRules.length; i++) {
      if (host.indexOf(refRules[i].match) > -1) {
        return JSON.stringify({ 'Referer': refRules[i].ref, 'User-Agent': SPIDER.UA });
      }
    }
  } catch (e) {}
  return '';
}

// ---------- 集数枚举（2026-09-20 修复：详情页原先永远只有"正片"一集） ----------
// 每源可提供：
//   epsPage(ident)  → 详情页 URL
//   epsRe           → 匹配 (path, label) 的正则（label 在同锚点内或紧邻）
//   epPath(path)    → 可直接传给 play() 的"播放路径"
//
// sid 归一化：同一 sid 只保留一条链（主线路），第一遇到视为主导线路。
function _cleanEpLabel(raw) {
  return String(raw || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// 2026-09-20 v7: 空结果 60s 重试——避免一次失败永久卡"正片"
var _EP_TTL = 60000;
function _episodes(src, ident) {
  var ck = src.name + '|' + ident;
  var rec = _EP_CACHE[ck];
  if (rec !== undefined) {
    if (rec.list.length > 1 || rec.list[0].ep !== '正片') return rec.list;  // 正式多集缓存
    if (Date.now() - rec.t < _EP_TTL) return rec.list;                      // 刚失败过，跳过
  }
  var out = [];
  try {
    if (src.epsPage && src.epsRe) {
      var dh = _req(src.epsPage(ident)) || '';
      if (dh.length > 400) {
        var re2 = src.epsRe;
        re2.lastIndex = 0;
        var tmp = null, firstSid = null, seenPath = {}, seenLbl = {};
        while ((tmp = re2.exec(dh)) !== null) {
          var path = tmp[1];
          if (seenPath[path]) continue;
          // 抽 sid: /play/id/{vid}/sid/{sid}/nid/{nid} 、 /play/{vid}-{sid}-{nid}.html
          // /iyfplay/{vid}-{sid}-{nid}/  、 /dsshiyipy/{vid}-{sid}-{nid}.html
          // 2026-09-20 按源分别解析 sid/nid：
          // 八天: /play/id/{vid}/sid/{S}/nid/{E}.html  → S=线路, E=集
          // 视觉: /vodplay/{vid}-{S}-{E}.html
          // 毒舌: /dsshiyipy/{vid}-{S}-{E}.html
          // 爱壹帆: /iyfplay/{vid}-{S}-{E}/
          var sm = src.name === '八天电影'
              ? /play\/id\/\d+\/sid\/(\d+)\/nid\/(\d+)/.exec(path)
              : src.name === '视觉影院'
              ? /vodplay\/\d+-(\d+)-(\d+)\.html/.exec(path)
              : src.name === '毒舌影视'
              ? /dsshiyipy\/\d+-(\d+)-(\d+)\.html/.exec(path)
              : src.name === '爱壹帆影视'
              ? /iyfplay\/\d+-(\d+)-(\d+)/.exec(path)
              : null;
          if (!sm) continue;
          var sid = sm[1];       // 主线路
          var nid = sm[2];       // 集号
          // 2026-09-20 标签清洗：站点上剧集 title 多为"播放{片名}第XX集"，
          // 统一提取"第XX集"做 label；为按钮锚点(无集数)时丢弃
          var lbl = _cleanEpLabel(tmp[2]).replace(/^立刻播放|^播放/g, '');
          var lblNum = /第(\d+)集/.exec(lbl);
          if (lblNum) {
            var en = parseInt(lblNum[1], 10);
            lbl = '第' + (en < 10 ? '0' + en : en) + '集';
          } else if (out.length === 0) {
            // 首集无集数标记——这是"全集/电影/按钮锚点"
            lbl = '正片';
          }
          if (!lbl) continue;
          if (seenLbl[lbl]) continue;
          if (firstSid === null) firstSid = sid;
          if (sid !== firstSid) continue;
          seenLbl[lbl] = 1; seenPath[path] = 1;
          // 弃掉无集数的"重复按钮锚点"（同一 path 出现『第002集』更多有意义）
          out.push({ ep: lbl, path: path });
        }
      }
    }
  } catch (e) { out = []; }
  if (!out.length) out = [{ ep: '正片', path: ident }];
  _EP_CACHE[ck] = { list: out, t: Date.now() };
  return out;
}

function _detailUrlFor(src, ident) {
  try { if (src.epsPage) return src.epsPage(ident); } catch (e) {}
  return null;
}

// 按片名扫描各源，返回 [{name, url}]（url 为 m3u8 直链）
// 2026-09 改版：最快命中的源直接返回（1 条线路），后续调用由缓存秒回
function _scanTitle(title) {
  if (!title) return [];
  var key = 's:' + title;
  if (_SCAN_CACHE[key]) return _SCAN_CACHE[key];
  var results = [];
  var hit = false;
  // 2026-09-20 效率优先：按历史命中率排序后只扫前 4 个源，
  // 后面的源基本是慢/死域名，白拖用户等待。
  var order = _srcOrder().slice(0, 4);
  for (var oi = 0; oi < order.length && !hit; oi++) {
    var i = order[oi];
    var src = SCAN_SOURCES[i];
    // SCAN_BINDING：只执行白名单内的独立爬虫源
    if (!SCAN_BINDING.hasOwnProperty(src.name)) continue;
    var st = _SRC_STATS[src.name] || (_SRC_STATS[src.name] = { n: 0, ms: 0, ok: 0 });
    var t0 = Date.now();
    try {
      // 自定义多步取线（追光/七猫等）优先
      if (typeof src.fetchLine === 'function') {
        var line = src.fetchLine(title);
        if (line && line.url && (_trustedSource(src) || _verifyM3u8(line.url))) {
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
      if (real && (_trustedSource(src) || _verifyM3u8(real))) {
        var picM2 = null;
        try { if (src.picRe) { var win2 = html.slice(Math.max(0, m.index - 900), m.index + 900); picM2 = src.picRe.exec(win2); } } catch (e9) {}
        results.push({ name: src.name, url: real, ident: m[1],
                       pic: picM2 && picM2[1] ? (src.picBase || '') + picM2[1] : '' });
        hit = true;
      }
    } catch (e) {
    } finally {
      st.n++;
      st.ms += (Date.now() - t0);
      if (hit) st.ok++;
    }
  }
  // 2026-09 加固六：空结果不缓存——原实现把空结果永久缓存，一次抖动后该
  // 片名直到重启都拿不到线路；站点/CDN 恢复后只需刷新详情即可复活
  if (results.length > 0) _SCAN_CACHE[key] = results;
  return results;
}

// ---------- 播放：忠实原版（不内置任何第三方播放源） ----------

function _play(flag, id, flags) {
  var u = String(id || '');
  // 2026-09-20: EP::线路名::路径 —— 长剧集 lazy 解析，播放时按需抓播放页提直链
  if (u.indexOf('EP::') === 0) {
    var p = u.split('::');
    var srcName = p && p[1] ? p[1] : '';
    var epPath = p && p.length > 2 ? p.slice(2).join('::') : '';
    var resolved = '';
    try {
      var epSrc = null;
      for (var si = 0; si < SCAN_SOURCES.length; si++) {
        if (SCAN_SOURCES[si].name === srcName) { epSrc = SCAN_SOURCES[si]; break; }
      }
      if (epSrc && epSrc.epPlay && epPath) {
        var ppUrl = epSrc.epPlay(epPath);
        var ph = _req(ppUrl) || '';
        if (ph.length > 400) {
          epSrc.m3u8Re.lastIndex = 0;
          var epMm = epSrc.m3u8Re.exec(ph);
          if (epMm && epMm[1]) resolved = epMm[1].replace(/\\\//g, '/');
        }
      }
    } catch (e0) { resolved = ''; }
    u = resolved || '';
  }
  if (!u) u = '';
  return JSON.stringify({
    parse: '0',
    jx: '0',
    header: _playHeadersFor(u),
    playUrl: '',
    url: u
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