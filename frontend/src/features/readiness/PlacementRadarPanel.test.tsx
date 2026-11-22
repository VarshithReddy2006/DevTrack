import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,it,expect,vi} from 'vitest';
import {PlacementRadarPanel} from './components/PlacementRadarPanel';
const state=vi.hoisted(()=>({userId:'owner-a',get:vi.fn()}));
vi.mock('@clerk/clerk-react',()=>({useAuth:()=>({userId:state.userId,isLoaded:true,isSignedIn:true})}));
vi.mock('../../utils/axiosClient',()=>({default:{get:state.get}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();state.userId='owner-a';});
it('shows unknown evidence, changes goal, prints and isolates account cache',async()=>{
 state.get.mockResolvedValue({data:{success:true,data:{version:'v1',generatedAt:'2026-11-22T00:00:00Z',coverage:0,caveat:'Practice only',axes:['structures','algorithms','architecture','coreCs','behavioral'].map(key=>({key,label:key,score:null,evidence:[],gap:'No evidence'})),plan:[{day:1,axis:'coreCs',minutes:30,task:'Review OS'}],signals:{contestRatings:[],retentionPercent:null,reviews7d:0,consistencyPercent:null}}}});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const view=render(<QueryClientProvider client={client}><PlacementRadarPanel/></QueryClientProvider>);
 expect(await screen.findByText('Review OS',{exact:false})).toBeVisible();expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(5);
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'advanced'}});expect(screen.getByText('advanced practice goal (dashed)')).toBeVisible();
 const print=vi.spyOn(window,'print').mockImplementation(()=>{});fireEvent.click(screen.getByRole('button',{name:'Print / Save PDF'}));expect(print).toHaveBeenCalledOnce();
 expect(client.getQueryData(['placementRadar','owner-a'])).toBeDefined();state.userId='owner-b';view.rerender(<QueryClientProvider client={client}><PlacementRadarPanel/></QueryClientProvider>);
 await screen.findByText('Review OS',{exact:false});expect(state.get).toHaveBeenCalledTimes(2);client.clear();
});
