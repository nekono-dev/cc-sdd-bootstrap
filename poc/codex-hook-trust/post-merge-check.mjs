// 取り込み後の確認（codex-hook-trust のタスク 5.3）: develop の普通の checkout と worktree で、承認の確認画面なしにフックが動くことを確かめる。
// 使い方: node poc/codex-hook-trust/post-merge-check.mjs   認証済みの codex と、リポジトリへの git の取得権限が要る（POC_REPO で取得元を変えられる。既定はこのリポジトリの origin）。
//   一時の CODEX_HOME・HOME だけを使い、利用者の実際の ~/.codex/config.toml は変更しない（auth.json の写しだけ実ホームから取る。内容は読まない・表示しない）。
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const run=(cmd,args,opt={})=>spawnSync(cmd,args,{encoding:"utf8",...opt});
const base=fs.mkdtempSync(path.join(os.tmpdir(),"cht53-"));
const repo=path.join(base,"normal"), wt=path.join(base,"wt");
const here=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const origin=process.env.POC_REPO??run("git",["-C",here,"remote","get-url","origin"]).stdout.trim();
let r=run("git",["clone","-q","--branch",process.env.POC_BRANCH??"develop",origin,repo]); if(r.status!==0){console.log("clone 失敗",r.stderr);process.exit(1);}
const head=run("git",["-C",repo,"log","--oneline","-1"]).stdout.trim();
const home=path.join(base,"home"), h=path.join(base,"h"); fs.mkdirSync(home); fs.mkdirSync(h);
fs.copyFileSync(path.join(os.homedir(),".codex","auth.json"),path.join(home,"auth.json"));
const real=fs.realpathSync(repo);
fs.writeFileSync(path.join(home,"config.toml"),`[projects.${JSON.stringify(real)}]\ntrust_level = "trusted"\n`);
const env={...process.env,CODEX_HOME:home,HOME:h,CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS:"5000"};
const cli=path.join(real,"bin/cc-sdd-bootstrap.mjs");
const hookLines=(o)=>(o.match(/^hook: .*$/gm)||[]);
const table=()=>(fs.readFileSync(path.join(home,"config.toml"),"utf8").match(/^\[hooks\.state\./gm)||[]).length;
const codex=(cwd)=>run("codex",["-a","never","exec","--sandbox","read-only","--skip-git-repo-check","--model","gpt-6-luna","--config",'model_reasoning_effort="low"',"--cd",cwd,"OK とだけ答えて"],{env,timeout:240000});
const res=[]; const rec=(n,ok,ev)=>{res.push(ok);console.log(`${ok?"PASS":"FAIL"} ${n}\n   ${ev}`);};
console.log("develop の先頭:",head);
// 1) 普通の checkout
r=run("node",[cli,"update"],{cwd:real,env});
const ok1=r.status===0&&/承認の記録を書きました/.test(r.stdout)&&table()===8;
rec("普通の checkout で update: 記録 8 件が書かれる",ok1,`終了コード ${r.status}、表 ${table()} 件、${(r.stdout.match(/Codex のフックの承認の記録[^\n]*/)||[""])[0]}`);
r=codex(real); const l1=hookLines(r.stdout+r.stderr);
rec("普通の checkout で codex を起動: 確認画面なしでフックが動く",r.status===0&&l1.some(x=>/SessionStart Completed/.test(x)),`終了コード ${r.status}、${[...new Set(l1)].join(" / ")}`);
// 2) worktree
r=run("git",["-C",real,"-c","user.name=t","-c","user.email=t@example.invalid","worktree","add","-q","--detach",wt]);
if(r.status!==0){console.log("worktree 失敗",r.stderr);process.exit(1);}
const before=fs.readFileSync(path.join(home,"config.toml"),"utf8");
r=run("node",[path.join(wt,"bin/cc-sdd-bootstrap.mjs"),"update"],{cwd:wt,env});
const after=fs.readFileSync(path.join(home,"config.toml"),"utf8");
rec("worktree で update: 本体の checkout の記録が最新のまま（変更なし 8）",r.status===0&&/最新です/.test(r.stdout)&&before===after&&!after.includes(fs.realpathSync(wt)),`終了コード ${r.status}、${(r.stdout.match(/Codex のフックの承認の記録[^\n]*/)||[""])[0]}`);
r=codex(fs.realpathSync(wt)); const l2=hookLines(r.stdout+r.stderr);
rec("worktree で codex を起動: 確認画面なしでフックが動く",r.status===0&&l2.some(x=>/SessionStart Completed/.test(x)),`終了コード ${r.status}、${[...new Set(l2)].join(" / ")}`);
r=run("node",[path.join(wt,"bin/cc-sdd-bootstrap.mjs"),"uninstall"],{cwd:wt,env});
const after2=fs.readFileSync(path.join(home,"config.toml"),"utf8");
rec("worktree から uninstall: 記録が残る（理由が表示される）",r.status===0&&after2===after&&table()===8&&/worktree/.test(r.stdout),`終了コード ${r.status}、表 ${table()} 件、${(r.stdout.match(/Codex のフックの承認の記録[^\n]*/)||[""])[0]}`);
// 3) 本体で uninstall
r=run("node",[cli,"uninstall"],{cwd:real,env});
rec("普通の checkout から uninstall: 記録が取り除かれる",r.status===0&&table()===0&&/取り除きました/.test(r.stdout),`終了コード ${r.status}、表 ${table()} 件`);
console.log(res.every(Boolean)?"結果: PASS "+res.length+" / "+res.length:"結果: FAIL");
if(!process.env.POC_KEEP) fs.rmSync(base,{recursive:true,force:true});
process.exit(res.every(Boolean)?0:1);
