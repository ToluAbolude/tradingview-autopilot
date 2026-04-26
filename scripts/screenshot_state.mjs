import { evaluate } from '../src/connection.js';
import { writeFileSync } from 'fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Close the dropdown first
await evaluate(`(function(){
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
})()`);
await sleep(500);

// Take a screenshot via CDP
const { Runtime } = await import('../src/connection.js');
// Use captureScreenshot directly
const result = await evaluate(`(function(){
  // Check what strategies are on chart via different API paths
  var info = {};

  // Path 1: tvWidget
  try {
    var tw = window.tvWidget || window.TradingView.tvWidget;
    if (tw) {
      var studies = tw.chart().getAllStudies();
      info.tvWidget_studies = studies.map(function(s){ return s.name + '(id=' + s.entityId + ')'; });
    }
  } catch(e) { info.tvWidget_err = e.message; }

  // Path 2: activeChartWidget
  try {
    var cw = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value();
    if (cw) {
      var ss = cw.getAllStudies ? cw.getAllStudies() : 'no getAllStudies';
      info.cw_studies = Array.isArray(ss) ? ss.map(function(s){ return s.name; }) : ss;
    }
  } catch(e) { info.cw_err = e.message; }

  // Path 3: look for strategy indicators in DOM (legend, pane title)
  try {
    var titles = document.querySelectorAll('[class*="paneTitle"], [class*="study-title"], [class*="StudyTitle"], [class*="legendItem"], [class*="legend-"]');
    var names = [];
    titles.forEach(function(t) {
      if (t.offsetParent) {
        var text = t.textContent.trim().substring(0,60);
        if (text) names.push(text);
      }
    });
    info.visible_titles = names.slice(0,20);
  } catch(e) { info.title_err = e.message; }

  // Path 4: datasources
  try {
    var frame = window.frameElement;
    var src = [];
    if (window.TradingViewApi && window.TradingViewApi.dataSources) {
      window.TradingViewApi.dataSources().forEach(function(s, i) {
        if (s && s.metaInfo) {
          var mi = s.metaInfo();
          if (mi && /strat|alpha|kill|ORB|backtest/i.test(mi.shortTitle || mi.name || '')) {
            src.push(i + ':' + (mi.shortTitle || mi.name));
          }
        }
      });
      info.strategy_sources = src;
    }
  } catch(e) { info.ds_err = e.message; }

  return JSON.stringify(info, null, 2);
})()`);

console.log('Chart state:');
console.log(result);
