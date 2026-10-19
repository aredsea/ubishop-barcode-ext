/* saleimport-panel-harness.js — 판매 처리 패널(src/saleimport.js)을 node vm 에서 DOM·chrome 가짜 객체로 띄워 내부 함수(run·confirmPicker·entryRows…)를 호출한다.
 * 패널 소스는 고치지 않는다: 마지막 `})();` 앞에 내보내기 한 줄만 끼워 읽는다. 테스트(tests/saleimport-manual.test.js)와 스냅샷 도구(tools/render-saleimport-pick.js)가 쓴다. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'src', 'saleimport-core.js'));

//  erp: 패널이 부르는 E.* 가짜. store: chrome.storage.local 초기값. 반환 = { S, api, calls, alerts, sandbox }.
function loadPanel(erp, store) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'saleimport.js'), 'utf8').replace(/\r\n/g, '\n');
  const end = src.lastIndexOf('})();');
  if (end < 0) throw new Error('패널 소스 끝을 못 찾음');
  const hook = "  globalThis.__sl = { S, run, runPlans, openPicker, confirmPicker, pickToggle, pickState, manualRevalidate, entryRows, pickerHtml, manualBtn, setBlock, applyOverlaps, entryReady, counts, CSS, ICON_DEFS, esc, fmt };\n";
  const code = src.slice(0, end) + hook + src.slice(end);
  const alerts = [], calls = [];
  const sandbox = {
    console, setTimeout, clearTimeout, URL, Blob: globalThis.Blob,
    location: { pathname: '/sale/item/saleItemWriteForm.do' },
    chrome: {
      storage: {
        local: {
          get: (q, cb) => cb(Object.assign({}, q, { ubSkin: true, ubSaleImport: true }, store || {})),
          set: (o, cb) => { Object.assign(store || {}, o); if (cb) cb(); }
        },
        onChanged: { addListener() {} }
      },
      runtime: { sendMessage() {}, lastError: null }
    },
    document: { getElementById: () => null, addEventListener() {}, createElement: () => ({ style: {}, appendChild() {}, remove() {} }), activeElement: null, head: { appendChild() {} }, body: { appendChild() {} } },
    alert: (m) => { alerts.push(String(m)); },
    confirm: () => true,
    ubSl: C,
    ubSlErp: new Proxy(erp || {}, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { calls.push(String(k)); return t[k](...a); } : t[k]) })
  };
  sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
  sandbox.window = sandbox; sandbox.top = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'saleimport.js' });
  return { S: sandbox.__sl.S, api: sandbox.__sl, calls, alerts, sandbox };
}
module.exports = { loadPanel };
