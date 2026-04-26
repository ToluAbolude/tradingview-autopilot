import { evaluate } from '../src/connection.js';

const r = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.metaInfo) continue;
      try {
        var desc = (s.metaInfo().description || s.metaInfo().shortDescription || '');
        if (desc.indexOf('HTF Filter') < 0 && desc.indexOf('HTF_ST') < 0) continue;

        // List all own keys
        var allKeys = Object.keys(s);
        var underKeys = allKeys.filter(function(k){ return k.startsWith('_'); });

        // Try every plausible data path
        var paths = {};

        // _data
        var d = s._data;
        if (d && typeof d.value === 'function') d = d.value();
        paths['_data type'] = d ? typeof d : 'null';
        paths['_data keys'] = d ? Object.keys(d).slice(0,15).join(',') : '';
        if (d && d.plots) paths['_data.plots length'] = d.plots.length;

        // _plotsData
        var pd = s._plotsData;
        if (pd && typeof pd.value === 'function') pd = pd.value();
        paths['_plotsData'] = pd ? (typeof pd + ' keys:' + Object.keys(pd).slice(0,8).join(',')) : 'null';

        // _kernel
        var k = s._kernel;
        if (k) {
          var kd = k._data;
          if (kd && typeof kd.value === 'function') kd = kd.value();
          paths['_kernel._data'] = kd ? Object.keys(kd).slice(0,8).join(',') : 'null';
        }

        // _pineInstance or similar
        var pi = s._pineInstance || s.pineInstance;
        paths['_pineInstance'] = pi ? typeof pi : 'null';

        // plots via study primitive
        var sp = s._studyPrimitive;
        paths['_studyPrimitive'] = sp ? typeof sp : 'null';

        // _internal
        var ii = s._internalInstance;
        paths['_internalInstance'] = ii ? typeof ii : 'null';

        // Try to get last bar values via a different approach
        // Check _source (sometimes has plot series)
        var src = s._source;
        if (src && typeof src.value === 'function') src = src.value();
        paths['_source type'] = src ? typeof src : 'null';
        if (src) paths['_source keys'] = Object.keys(src).slice(0,10).join(',');

        // Check studyData method
        if (typeof s.studyData === 'function') {
          var sd = s.studyData();
          paths['studyData()'] = sd ? JSON.stringify(sd).substring(0,200) : 'null';
        }

        // series() method
        if (typeof s.series === 'function') {
          var ser = s.series();
          paths['series() length'] = ser ? ser.length : 'null';
          if (ser && ser.length > 0) {
            var s0 = ser[0];
            paths['series[0] keys'] = Object.keys(s0).slice(0,10).join(',');
            // try data on series[0]
            var s0d = s0._data || s0.data;
            if (s0d && typeof s0d.value === 'function') s0d = s0d.value();
            paths['series[0]._data type'] = s0d ? typeof s0d : 'null';
            if (Array.isArray(s0d)) paths['series[0]._data last'] = s0d[s0d.length-1];
          }
        }

        return {
          desc: desc,
          keyCount: allKeys.length,
          underKeys: underKeys.join(','),
          paths: paths
        };
      } catch(e) { return { findErr: e.message }; }
    }
    return { notFound: true };
  } catch(e) { return { topErr: e.message }; }
})()`);

console.log(JSON.stringify(r, null, 2));
