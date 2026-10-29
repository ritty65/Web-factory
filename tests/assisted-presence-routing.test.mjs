import test from 'node:test';
import assert from 'node:assert/strict';
import {assistedPresenceTarget} from '../src/intake.mjs';
const observed=(url,finalUrl)=>({id:'external-presence-fixture',url,finalUrl,method:'assisted_external_guest_dom',sourceKind:'external_observation',inspectedAt:new Date().toISOString(),blocked:true,text:''});
const route=(url,finalUrl)=>assistedPresenceTarget({url},[observed(url,finalUrl)],[{url,sourceId:'external-presence-fixture',status:'unofficial'}]);
test('assisted TikTok profile routing permits observed share tracking without trusting unreadable content',()=>{
  const url='https://www.tiktok.com/@synthetic.detail?_r=1&_t=zp-example';assert.equal(route(url,url),true);
  for(const bad of ['https://www.tiktok.com/@synthetic.detail?redirect=https://customer.example/','https://www.tiktok.com/@synthetic.detail?_t=https://customer.example/','https://www.tiktok.com/@synthetic.detail?_r=1&_r=2'])assert.equal(route(bad,bad),false);
  assert.equal(route(url,'https://customer.example/'),false);
});
test('observed Google business-profile share routing is not an independent website or readable listing assertion',()=>{
  const url='https://share.google/ExampleReview123',business='https://www.google.com/search?kgmid=%2Fg%2Fsynthetic123&q=Synthetic+Detailing&source=sh%2Fx%2Floc';
  assert.equal(route(url,'https://www.google.com/sorry/index?continue='+encodeURIComponent(business)),true);
  assert.equal(route(url,business),true);
  for(const final of ['https://customer.example/','https://www.google.com/url?q=https://customer.example/','https://www.google.com/search?q=Synthetic','https://www.google.com/search?kgmid=/g/synthetic&redirect=https://customer.example/','https://www.google.com/sorry/index?continue='+encodeURIComponent('https://customer.example/')])assert.equal(route(url,final),false);
  assert.equal(assistedPresenceTarget({url},[],[{url,sourceId:'external-presence-fixture',status:'unofficial'}]),false);
});
