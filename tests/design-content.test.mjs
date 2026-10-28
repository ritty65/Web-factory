import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateWithDesignContent} from '../src/production.mjs';
test('validated design facts enrich only the creative snapshot, never mutate canonical identity or qualification',()=>{
 const candidate={id:'lead-fixture',facts:[{id:'fact-1',text:'Original source fact'}],sourceUrls:['https://www.facebook.com/fixture'],contacts:{facebook:'https://www.facebook.com/fixture'},assessment:{state:'qualified'}},before=JSON.stringify(candidate);
 const content={facts:[{id:'design-fact-1',text:'Interior service description',excerpt:'Interior service description',sourceUrl:'https://booksy.com/en-us/123_fixture'}],contacts:{phone:'invented'},assessment:{state:'accepted'}};
 const value=candidateWithDesignContent(candidate,content);assert.equal(value.facts.length,2);assert.equal(value.facts[1].id,'design-fact-1');assert.deepEqual(value.contacts,candidate.contacts);assert.deepEqual(value.assessment,candidate.assessment);assert.equal(JSON.stringify(candidate),before);assert.ok(value.sourceUrls.includes('https://booksy.com/en-us/123_fixture'));
});
test('design context without additional verified facts preserves the ordinary candidate exactly',()=>{
 const c={id:'lead-fixture',facts:[],sourceUrls:[]};assert.equal(candidateWithDesignContent(c,null),c);
});
