import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import axiosClient from '../../../utils/axiosClient';
import { ReadinessSpiderChart } from './ReadinessSpiderChart';
import { PRACTICE_GOALS, radarReportText, type PlacementRadarReport } from '../placementRadar';
export function PlacementRadarPanel() {
  const {userId,isSignedIn,isLoaded}=useAuth();
  const [tier,setTier] = useState<keyof typeof PRACTICE_GOALS>('intermediate');
  const {data,isLoading,isError,refetch} = useQuery({queryKey:['placementRadar',userId],enabled:isLoaded&&isSignedIn,queryFn:async ({signal}) => {
    const response = await axiosClient.get<{success:boolean;data:PlacementRadarReport}>('/readiness/placement-radar',{signal});
    if (!response.data.success) throw new Error('Radar unavailable');
    return response.data.data;
  },staleTime:60000,retry:1});
  const [exportError,setExportError] = useState('');
  function download() {
    if (!data) return;
    let url:string|undefined;
    try {
      url=URL.createObjectURL(new Blob([radarReportText(data,PRACTICE_GOALS[tier])],{type:'text/plain;charset=utf-8'}));
      const link=document.createElement('a'); link.href=url; link.download='placement-practice-report.txt'; link.click(); setExportError('');
    } catch {setExportError('Report could not be downloaded. Try printing instead.');}
    finally {if(url) window.setTimeout(() => URL.revokeObjectURL(url!),1000);}
  }
  return <section aria-labelledby="placement-title" className="rounded-2xl border border-slate-200 bg-white p-5 text-slate-800">
    <h2 id="placement-title" className="text-xl font-bold">Placement practice radar</h2>
    <p className="text-sm text-slate-500">Five evidence axes, a seven-day practice plan, and an exportable report.</p>
    {isLoading && <p role="status">Loading practice evidence…</p>}
    {isError && <div role="alert">Practice evidence could not be loaded. <button onClick={() => void refetch()}>Retry radar</button></div>}
    {data && <>
      <p className="my-3 text-sm">{data.caveat}</p>
      <label className="block">Practice goal <select value={tier} onChange={e => setTier(e.target.value as keyof typeof PRACTICE_GOALS)} className="border rounded p-2 ml-2">
        {Object.keys(PRACTICE_GOALS).map(key => <option key={key} value={key}>{key} ({PRACTICE_GOALS[key as keyof typeof PRACTICE_GOALS]}/100)</option>)}
      </select></label>
      <p className="text-xs mt-2">Illustrative goals only. No company tier or hiring percentile is inferred. Evidence coverage: {data.coverage}/5 axes.</p>
      <div className="grid md:grid-cols-2 gap-6 mt-4">
        <div><ReadinessSpiderChart targetLabel={`${tier} practice goal`} dimensions={data.axes.map(a => ({key:a.key,label:a.label,score:a.score??0,unavailable:a.score===null,target:PRACTICE_GOALS[tier],gap:a.gap}))}/>
        <p className="text-xs">Unknown axes are drawn at the center for layout only; use the table for evidence status.</p></div>
        <table className="text-sm text-left"><caption className="font-semibold mb-2">Evidence and diagnosis (last seven days)</caption><thead><tr><th>Axis</th><th>Score</th><th>Diagnosis</th></tr></thead><tbody>
          {data.axes.map(a => <tr key={a.key} className="border-t"><th scope="row" className="pr-2">{a.label}</th><td>{a.score??'Unknown'}</td><td className="py-2">{a.gap}{a.evidence.map(e => <p key={e} className="text-xs text-slate-500">{e}</p>)}</td></tr>)}
        </tbody></table>
      </div>
      <p className="text-sm my-3">Contest ratings (different platform scales): {data.signals.contestRatings.join(', ')||'Unknown'} · Review retention: {data.signals.retentionPercent===null?'Unknown':`${data.signals.retentionPercent}%`} ({data.signals.reviews7d} reviews) · Solve consistency: {data.signals.consistencyPercent===null?'Unknown':`${data.signals.consistencyPercent}%`}</p>
      <h3 className="font-semibold">Seven-day practice plan</h3><ol className="list-decimal pl-5 text-sm space-y-2 my-3">{data.plan.map(p => <li key={p.day}>Day {p.day} · {p.minutes} min · {p.task}</li>)}</ol>
      <p className="text-xs">Generated {new Date(data.generatedAt).toLocaleString()} · {data.version}</p>
      <div className="flex gap-4 mt-3"><button className="border rounded px-3 py-2" onClick={download}>Export text report</button><button className="border rounded px-3 py-2" onClick={() => window.print()}>Print / Save PDF</button></div>
      {exportError && <p role="alert">{exportError}</p>}
    </>}
  </section>;
}
