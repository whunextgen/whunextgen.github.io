// 私信只入内存队列，绝不连接飞书。所有人员与身份均为虚构。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync,readdirSync,writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
for(const f of readdirSync('supabase/migrations').sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
const q=async(s,p=[])=>(await db.query(s,p)).rows;
let assertions=0;
const eq=(a,b)=>{assert.deepEqual(a,b);assertions++;};
const user=async(name,kind='ri',rank='intern',feishu=true,role='member')=>{
 const uid=(await q('insert into app_user(name,role,feishu_union_id) values($1,$2,$3) returning id',[name,role,feishu?'on_test_'+name:null]))[0].id;
 await q("insert into person(name,user_id,kind,rank,status) values($1,$2,$3,$4,'active')",[name,uid,kind,rank]);return uid;
};
const hr=await user('虚构人事','ra','researcher'), owner=await user('虚构负责人','phd','researcher'), plain=await user('虚构只读经办','ra','researcher'), director=await user('虚构中心负责人','teacher','director',true,'director');
const apply=await user('虚构未申请'), contact=await user('虚构已意向'), assistant=await user('虚构Assistant硕士','master','assistant'), joined=await user('虚构已加入'), unbound=await user('虚构无飞书','phd','intern',false), disabled=await user('虚构停用'), withdrawn=await user('虚构已撤回'), invalid=await user('虚构无效意向'), noOwner=await user('虚构负责人待明确');
await q("insert into person(name,kind,rank,status) values('虚构未关联','master','intern','active')");
await q('update app_user set active=false where id=$1',[disabled]);
await q("insert into rbac_grant(user_id,role_id,from_date) select $1,id,app_today() from rbac_role where code='hr'",[hr]);
await q("insert into rbac_grant(user_id,role_id,from_date) select $1,id,app_today() from rbac_role where code='auditor'",[plain]);
const project=async(code,parent=null,active=true,ownerId=owner)=>(await q('insert into project(code,name,owner_id,layer,parent_id,active) values($1,$1,$2,$3,$4,$5) returning id',[code,ownerId,parent?'paper':'big',parent,active]))[0].id;
const p=await project('DEMO-ONE'),unit=await project('DEMO-UNIT',p),p2=await project('DEMO-TWO'),closed=await project('DEMO-CLOSED',null,false),empty=await project('DEMO-NO-OWNER',null,true,null);
for(const [uid,pid,status] of [[contact,p,'open'],[contact,p2,'open'],[assistant,p,'open'],[joined,p,'open'],[withdrawn,p,'withdrawn'],[invalid,closed,'open'],[noOwner,empty,'open']])await q("insert into recruit_interest(user_id,project_id,note,status) values($1,$2,'虚构内容',$3)",[uid,pid,status]);
await q('insert into project_member(project_id,user_id,joined_on) values($1,$2,app_today())',[unit,joined]);
const as=async uid=>{await db.exec('reset role');await q("select set_config('app.uid',$1,false)",[uid||'']);await db.exec('set role app_api');};
for(const uid of [owner,plain,director,assistant,null]){
 await as(uid);
 for(const fn of ['preview_selection_reminders','send_selection_reminders']){
  await assert.rejects(()=>q(`select ${fn}()`),e=>e.code==='42501');assertions++;
 }
}
await as(hr);
eq((await q("select 'selection.remind'=any(my_perms()) ok"))[0].ok,true);
let preview=(await q('select preview_selection_reminders() data'))[0].data.recipients;
const target=uid=>preview.find(r=>r.user_id===uid&&r.audience!=='owner');
eq(target(apply).audience,'apply');eq(target(contact).audience,'contact');eq(target(assistant),undefined);eq(target(joined),undefined);
eq(target(unbound).blocked,'尚未绑定可用飞书身份');eq(target(disabled).blocked,'账号已停用');eq(preview.find(r=>r.user_id===null&&r.audience==='apply').blocked,'待关联账号');
eq(target(withdrawn).audience,'apply');eq(target(invalid).audience,'apply');
eq(preview.filter(r=>r.user_id===owner&&r.audience==='owner').length,1);
eq(preview.find(r=>r.user_id===owner).message.includes('DEMO-ONE'),true);eq(preview.find(r=>r.user_id===owner).message.includes('DEMO-TWO'),true);
eq(preview.find(r=>r.audience==='owner'&&r.user_id===null).blocked,'负责人待明确');
await db.exec('reset role');eq((await q('select count(*)::int n from selection_reminder_log'))[0].n,0);
if(process.env.REMINDER_DEMO_OUT){const blob=await db.dumpDataDir('gzip');writeFileSync(process.env.REMINDER_DEMO_OUT,Buffer.from(await blob.arrayBuffer()));}
const prior=(await q('select count(*)::int n from feishu_outbox'))[0].n;
await as(hr);
const expected=preview.filter(r=>!r.blocked).length;
const result=(await q('select send_selection_reminders() data'))[0].data;
eq(result.queued,expected);eq(result.skipped,preview.length-expected);
eq((await q('select send_selection_reminders() data'))[0].data.queued,0);
await db.exec('reset role');
const messages=await q("select * from feishu_outbox where payload ? 'selection_reminder'");
eq(messages.length,expected);eq(messages.every(m=>m.user_id&&m.target.startsWith('on_test_')&&m.payload.url==='#/select'),true);
eq(messages.some(m=>m.user_id===assistant||m.user_id===joined||m.user_id===disabled),false);
eq(messages.find(m=>m.user_id===contact).payload.text.includes('需要完成的小任务'),true);
eq(messages.find(m=>m.user_id===owner).payload.text.includes('将对方加入对应成员名单'),true);
eq((await q('select count(*)::int n from selection_reminder_log where outbox_id is not null'))[0].n,expected);
eq((await q('select count(*)::int n from feishu_outbox'))[0].n,prior+expected);
// 预览后成员已加入，发送必须重新核对；模拟清空日志仅操作虚构内存库。
await q('delete from selection_reminder_log');await q("delete from feishu_outbox where payload ? 'selection_reminder'");
await as(hr);await q('select preview_selection_reminders()');await db.exec('reset role');
await q('insert into project_member(project_id,user_id,joined_on) values($1,$2,app_today())',[p,contact]);
await as(hr);await q('select send_selection_reminders()');await db.exec('reset role');
eq((await q("select count(*)::int n from feishu_outbox where payload ? 'selection_reminder' and user_id=$1",[contact]))[0].n,0);
eq((await q("select count(*)::int n from feishu_outbox where payload->>'selection_reminder'='owner' and user_id=$1",[owner]))[0].n,0);
// 没有表权限，普通 API 账号不能绕过业务函数写日志或指定收件人。
await as(plain);await assert.rejects(()=>q('select * from selection_reminder_log'),e=>e.code==='42501');assertions++;
await db.exec('reset role');
console.log(`selection reminders: ${assertions} assertions passed`);await db.close();
