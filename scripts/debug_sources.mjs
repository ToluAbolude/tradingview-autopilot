import { evaluate } from '../src/connection.js';

const r = await evaluate(`(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    return sources.map(function(s,i){
      try {
        var meta = s.metaInfo ? s.metaInfo() : null;
        var desc = meta ? (meta.description || meta.shortDescription || 'no-desc') : 'no-meta';
        var hasData = !!(s._data || s.data || s._series);
        var hasReport = !!(s._reportData || s.reportData);
        return { i:i, desc:desc, hasData:hasData, hasReport:hasReport };
      } catch(e){ return {i:i, err:e.message}; }
    });
  } catch(e){ return {err:e.message}; }
})()`);

console.log('dataSources:', JSON.stringify(r, null, 2));
