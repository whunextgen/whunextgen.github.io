// 虚构名单验证：有效成员关系、尚未关联账号、历史退出与权限隔离。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
for (const f of readdirSync('supabase/migrations').sort()) await db.exec(readFileSync('supabase/migrations/' + f, 'utf8'));
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const user = async (name, role = 'member') => (await q('insert into app_user(name,role) values($1,$2) returning id', [name, role]))[0].id;
const hr = await user('虚构人事'), owner = await user('虚构博士'), joined = await user('虚构已加入'), intent = await user('虚构意向'), none = await user('虚构未加入'), inactive = await user('虚构停用'), left = await user('虚构已离开'), pending = await user('虚构待确认'), multiple = await user('虚构多课题');
await q("insert into rbac_grant(user_id,role_id,from_date) select $1,id,app_today() from rbac_role where code='hr'", [hr]);
for (const [name, uid, kind, status] of [['虚构已加入',joined,'ra','active'],['虚构意向',intent,'ri','active'],['虚构未加入',none,'master','offroll'],['虚构停用',inactive,'ra','active'],['虚构已离开',left,'ra','left'],['虚构待确认',pending,'ri','pending'],['虚构博士',owner,'phd','active'],['虚构未关联',null,'ra','active'],['虚构多课题',multiple,'master','active']]) {
 await q('insert into person(name,user_id,kind,status) values($1,$2,$3,$4)',[name,uid,kind,status]);
}
await q('update app_user set active=false where id=$1',[inactive]);
const project = async (code, layer = 'big', parent = null, active = true, proposed = false, kind = 'project') => (await q('insert into project(code,name,owner_id,layer,parent_id,active,proposed,kind) values($1,$1,$2,$3,$4,$5,$6,$7) returning id',[code,owner,layer,parent,active,proposed,kind]))[0].id;
const topic=await project('DEMO-A'), unit=await project('DEMO-A-1','paper',topic), closed=await project('DEMO-CLOSED','big',null,false), proposal=await project('DEMO-PROPOSAL','big',null,true,true), publicP=await project('DEMO-PUBLIC','big',null,true,false,'public');
for(const [uid,pid,exited,future] of [[joined,unit,false,false],[multiple,topic,false,false],[multiple,unit,false,false],[none,topic,true,false],[none,unit,false,true],[none,closed,false,false],[none,proposal,false,false],[none,publicP,false,false],[inactive,topic,false,false]])
 await q("insert into project_member(project_id,user_id,joined_on,left_on) values($1,$2,app_today()+$3::int,case when $4 then app_today() else null end)",[pid,uid,future?2:0,exited]);
await q("insert into recruit_interest(project_id,user_id,note) values($1,$2,'虚构意向')",[topic,intent]);
await q("insert into recruit_interest(project_id,user_id,note,status) values($1,$2,'已撤回','withdrawn')",[unit,none]);
const as = async uid => {await q("select set_config('app.uid',$1,false)",[uid||'']);await db.exec('set role app_api');const rows=await q('select * from api.selection_roster order by name');await db.exec('reset role');return rows;};
const rows=await as(hr), status=name=>rows.find(r=>r.name===name)?.selection_status;
assert.equal(rows.length,6);
assert.equal(status('虚构已加入'),'joined');assert.equal(status('虚构意向'),'interested');assert.equal(status('虚构未加入'),'unselected');assert.equal(status('虚构未关联'),'unlinked');assert.equal(status('虚构停用'),'inactive');
assert.equal(rows.find(r=>r.name==='虚构多课题').projects.length,2);
assert.equal(rows.find(r=>r.name==='虚构已加入').projects[0].parent_name,'DEMO-A');
assert.equal(rows.find(r=>r.name==='虚构未加入').projects.length,0);
assert.equal((await as(none)).length,1);assert.equal((await as(owner)).length,0);assert.equal((await as(null)).length,0);
assert.deepEqual(Object.keys(rows[0]).sort(),['id','user_id','name','kind','kind_label','selection_status','projects','interests'].sort());
// 验证负责人在现有名单中加人后，统计即时变为已加入；退出后恢复未加入。
await q("update project_member set joined_on=app_today() where user_id=$1 and project_id=$2 and left_on is null",[none,unit]);assert.equal((await as(hr)).find(r=>r.user_id===none).selection_status,'joined');
await q('update project_member set left_on=app_today() where user_id=$1 and project_id=$2 and left_on is null',[none,unit]);assert.equal((await as(hr)).find(r=>r.user_id===none).selection_status,'unselected');
if(process.env.SELECTION_DEMO_OUT){const blob=await db.dumpDataDir('gzip');writeFileSync(process.env.SELECTION_DEMO_OUT,Buffer.from(await blob.arrayBuffer()));}
console.log('selection roster: 15 assertions passed');await db.close();
