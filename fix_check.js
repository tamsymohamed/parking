const fs = require('fs');
const p = 'd:/qabda-cloudflare/qabda/test.fixes.js';
let c = fs.readFileSync(p, 'utf8');

// checkTest 함수에서 expectedVersion를 d.v로 변경
c = c.replace(/if\(st===undefined\|\|st!==expectedVersion\)return null;/, 'if(st===undefined||st!==d.v)return null;  // 서버 버전 !== 토큰 내 버전 → 세션 무효');
// 함수 시그니처에서 expectedVersion 제거
c = c.replace(/const checkTest=async\(t,u,expectedVersion\)=>/, 'const checkTest=async(t,u)=>');
// 테스트 호출부에서 expectedVersion 인자 제거 (세 번째 인자)
c = c.replace(/checkTest\(([^,]+),\s*'user-1',\s*\d+\)/g, 'checkTest($1, \'user-1\')');

fs.writeFileSync(p, c);
console.log('checkTest fixed. Verifying...');
const i = c.indexOf('const checkTest');
console.log(c.slice(i, i+250));