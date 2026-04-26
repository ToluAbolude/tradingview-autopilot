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

        // Check status fields
        var status = s._status;
        if (status && typeof status.value === 'function') status = status.value();

        var compActive = s._compileActiveStatus;
        if (compActive && typeof compActive.value === 'function') compActive = compActive.value();

        var compErr = s._compileErrorStatus;
        if (compErr && typeof compErr.value === 'function') compErr = compErr.value();

        var isStarted = s._isStarted;
        if (isStarted && typeof isStarted.value === 'function') isStarted = isStarted.value();

        var wasCompleted = s._wasCompletedBefore;
        if (wasCompleted && typeof wasCompleted.value === 'function') wasCompleted = wasCompleted.value();

        var restarting = s._restarting;
        if (restarting && typeof restarting.value === 'function') restarting = restarting.value();

        // Check resolved symbols
        var resolved = s._resolvedSymbols;
        if (resolved && typeof resolved.value === 'function') resolved = resolved.value();

        // Check _symbolsResolved
        var symRes = s._symbolsResolved;
        if (symRes && typeof symRes.value === 'function') symRes = symRes.value();

        return {
          desc: desc,
          status: status ? JSON.stringify(status).substring(0,200) : null,
          compileActive: compActive,
          compileError: compErr ? JSON.stringify(compErr).substring(0,200) : null,
          isStarted: isStarted,
          wasCompleted: wasCompleted,
          restarting: restarting,
          resolvedSymbolsType: typeof resolved,
          symbolsResolved: symRes,
          spc: s._simplePlotsCount,
          dataEnd: s._data ? s._data._end : 'no_data',
        };
      } catch(e) { return { err: e.message }; }
    }
    return { notFound: true };
  } catch(e) { return { topErr: e.message }; }
})()`);

console.log(JSON.stringify(r, null, 2));
