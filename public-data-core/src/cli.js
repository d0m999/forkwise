#!/usr/bin/env node
import { resolve } from 'node:path';
import { SecClient, sourceCatalog, companyFacts } from './index.js';

const [command,...args]=process.argv.slice(2);
try {
  if(command==='catalog') process.stdout.write(JSON.stringify(sourceCatalog,null,2)+'\n');
  else if(command==='sec') {
    const [cik,dataset='companyfacts',taxonomy,tag,unit,knownByDate]=args;
    const client=new SecClient({ userAgent:process.env.SEC_USER_AGENT,cacheDirectory:resolve(process.env.FORKWISE_DATA_CACHE ?? '.cache') });
    const snapshot=await client.fetch(cik,dataset);
    const {raw,...metadata}=snapshot;
    process.stdout.write(JSON.stringify({snapshot:metadata,...(taxonomy?{result:companyFacts(snapshot,{taxonomy,tag,unit,knownByDate})}:{})},null,2)+'\n');
  } else {
    process.stdout.write('用法：forkwise-data catalog\n      forkwise-data sec CIK [companyfacts|submissions] [taxonomy tag unit knownByDate]\n环境：SEC_USER_AGENT（真实联系信息），FORKWISE_DATA_CACHE（个人本机缓存）\n');
    if(command && command!=='--help') process.exitCode=2;
  }
} catch(error) { process.stderr.write(JSON.stringify({code:error.code ?? 'SOURCE_ERROR',message:error.message,details:error.details ?? null})+'\n');process.exitCode=1; }
