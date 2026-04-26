import { evaluate } from '../src/connection.js';

const r = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.metaInfo) continue;
      try {
        var desc = s.metaInfo().description || '';
        if (desc.indexOf('HTF Filter Comparison') < 0) continue;

        var out = { i: i, desc: desc };

        // _simplePlotsCount
        out.spc = s._simplePlotsCount;

        // _data details
        var d = s._data;
        out.dataType = typeof d;
        if (d) {
          out.dataKeys = Object.keys(d).join(',');
          out.end = d._end;
          out.start = d._start;
          var items = d._items;
          if (items) {
            out.itemsType = typeof items;
            out.itemsIsArr = Array.isArray(items);
            if (Array.isArray(items)) {
              out.itemsLen = items.length;
              if (items.length > 0) {
                var last = items[items.length-1];
                out.lastType = typeof last;
                out.lastIsArr = Array.isArray(last);
                out.lastLen = last ? last.length : null;
                out.lastVal = last ? JSON.stringify(last).substring(0,300) : null;
              }
            } else {
              // object / map-like
              var keys = Object.keys(items);
              out.itemsObjKeys = keys.length;
              if (keys.length > 0) {
                var lastKey = keys[keys.length-1];
                out.lastObjVal = JSON.stringify(items[lastKey]).substring(0,300);
              }
            }
          }
          // Try _plotFunctions
          if (d._plotFunctions) {
            out.plotFuncType = typeof d._plotFunctions;
            out.plotFuncLen = d._plotFunctions.length;
          }
        }

        // _lastNonEmptyPlotRowCache
        var lc = s._lastNonEmptyPlotRowCache;
        if (lc && typeof lc.value === 'function') lc = lc.value();
        out.lastNonEmpty = lc ? JSON.stringify(lc).substring(0,400) : null;

        // Try _series directly
        var ser = s._series;
        out.serType = typeof ser;
        if (ser) {
          out.serKeys = Object.keys(ser).slice(0,8).join(',');
          // If it has a length or get method
          if (ser.length !== undefined) out.serLen = ser.length;
        }

        // Try getting data via study's own methods
        if (typeof s.data === 'function') {
          var sd = s.data();
          out.dataFn = sd ? JSON.stringify(sd).substring(0,200) : null;
        }

        return out;
      } catch(e) { return { err: e.message }; }
    }
    return { notFound: true };
  } catch(e) { return { topErr: e.message }; }
})()`);

console.log(JSON.stringify(r, null, 2));
