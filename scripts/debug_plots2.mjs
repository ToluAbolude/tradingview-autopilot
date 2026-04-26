import { evaluate } from '../src/connection.js';

const r = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.metaInfo) continue;
      try {
        var desc = (s.metaInfo().description || '');
        if (desc.indexOf('HTF Filter') < 0 && desc.indexOf('HTF_ST') < 0) continue;

        var out = { desc: desc };

        // Probe _data._items (last bar)
        var d = s._data;
        if (d && d._items) {
          var items = d._items;
          var len = items.length || Object.keys(items).length;
          out['_data._items type'] = typeof items;
          out['_data._items length'] = len;
          // Try to get last item
          var lastItem = null;
          if (Array.isArray(items)) {
            lastItem = items[items.length - 1];
          } else if (items.get) {
            // Map-like
            var keys = Array.from(items.keys ? items.keys() : Object.keys(items));
            lastItem = items.get ? items.get(keys[keys.length-1]) : items[keys[keys.length-1]];
          }
          if (lastItem) {
            out['lastItem type'] = typeof lastItem;
            out['lastItem keys'] = Object.keys(lastItem).slice(0,10).join(',');
            // If it's an array of plot values
            if (Array.isArray(lastItem)) {
              out['lastItem (array)'] = lastItem.slice(0, 10);
            } else if (lastItem.plotValues || lastItem.plots) {
              out['lastItem.plotValues'] = lastItem.plotValues || lastItem.plots;
            } else if (lastItem.value) {
              out['lastItem.value'] = typeof lastItem.value === 'function' ? lastItem.value() : lastItem.value;
            }
          }
          // Also try _end index to get last bar
          var endIdx = d._end;
          out['_data._end'] = endIdx;
          if (typeof endIdx === 'number' && items.get) {
            var endItem = items.get(endIdx - 1);
            out['endItem'] = endItem ? JSON.stringify(endItem).substring(0,200) : 'null';
          }
        }

        // Probe _series
        var ser = s._series;
        out['_series type'] = typeof ser;
        if (ser) {
          out['_series keys'] = Object.keys(ser).slice(0,10).join(',');
          if (Array.isArray(ser)) {
            out['_series length'] = ser.length;
            if (ser.length > 0) {
              var s0 = ser[0];
              out['series[0] type'] = typeof s0;
              out['series[0] keys'] = Object.keys(s0).slice(0,12).join(',');
            }
          }
        }

        // Probe _simplePlotsCount
        out['_simplePlotsCount'] = s._simplePlotsCount;

        // Probe _lastNonEmptyPlotRowCache
        var lc = s._lastNonEmptyPlotRowCache;
        if (lc && typeof lc.value === 'function') lc = lc.value();
        out['_lastNonEmptyPlotRowCache'] = lc ? JSON.stringify(lc).substring(0,300) : 'null';

        return out;
      } catch(e) { return { err: e.message, stack: e.stack.substring(0,300) }; }
    }
    return { notFound: true };
  } catch(e) { return { topErr: e.message }; }
})()`);

console.log(JSON.stringify(r, null, 2));
