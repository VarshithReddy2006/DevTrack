import {it,expect} from 'vitest';
import {radarReportText,type PlacementRadarReport} from './placementRadar';
it('exports literal data with unknown evidence and seven-day actions, not HTML',()=>{
 const report:PlacementRadarReport={version:'v1',generatedAt:'2026-11-22',coverage:0,caveat:'Not a hiring probability',axes:[{key:'coreCs',label:'Core CS',score:null,evidence:[],gap:'<script> is literal text'}],plan:[{day:1,axis:'coreCs',minutes:30,task:'Review OS'}],signals:{contestRatings:[],retentionPercent:null,reviews7d:0,consistencyPercent:null}};
 const text=radarReportText(report,65);expect(text).toContain('Core CS: Unknown');expect(text).toContain('Day 1 (30 min): Review OS');expect(text).toContain('not an employer cutoff');expect(text).toContain('<script> is literal text');
});
