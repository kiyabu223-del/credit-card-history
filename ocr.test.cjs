const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const elements = new Map();
const handlers = {};
let calls = [], terminated = 0, response = '4,620', fail = false;
const context = {
  document: { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', style: {}, classList: { add() {}, remove() {} }, showModal() {},
      addEventListener(event, handler) { handlers[selector + event] = handler; },
    });
    return elements.get(selector);
  } },
  localStorage: { getItem() { return null; } }, navigator: {}, Intl, Date,
  console: { log() {}, warn() {}, error() {} }, URL: { createObjectURL() { return 'mock'; } },
  Tesseract: { async createWorker(language) {
    return {
      async setParameters(parameters) { calls.push({ language, parameters }); },
      async recognize() { if (fail) throw Error('OCR failed'); return { data: { text: response } }; },
      async terminate() { terminated++; },
    };
  } },
};
vm.createContext(context);
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
function line(parts, y) {
  let x = 10;
  return { words: parts.map(text => {
    const word = { text, box: { x0: x, x1: x + text.length * 15, y0: y, y1: y + 30 } };
    x = word.box.x1 + 5; return word;
  }), cy: y + 15, avgH: 30 };
}
(async () => {
  await context.recognizeCanvas({}, 'test', 0, 100, {
    language: 'eng', tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789,.',
  });
  assert.equal(calls[0].language, 'eng');
  assert.equal(calls[0].parameters.tessedit_pageseg_mode, '7');
  assert.equal(calls[0].parameters.tessedit_char_whitelist, '0123456789,.');
  assert.equal(terminated, 1);
  fail = true;
  await assert.rejects(context.recognizeCanvas({}, 'test', 0, 100));
  assert.equal(terminated, 2);
  fail = false;
  assert.equal(context.digitAmount('４，６２０'), 4620);
  assert.equal(context.digitAmount('4.620'), 4620);
  assert.equal(context.digitAmount('620'), 620);
  assert.equal(context.digitAmount('123abc'), '');
  for(const label of ['総額','お買上金額','お買い上げ金額','お支払い金額','ご請求金額','お会計','TOTAL','GRAND TOTAL','AMOUNT DUE']){
    assert.equal(context.parseAmount([line([label,'1,234'],600)]),1234,label);
    assert.equal(context.amountDigitRegions([line([label,'1,234'],600)],1000,1000).length,1,label);
  }
  assert.equal(context.parseAmount([line(['合計¥1,234'],600)]),1234);
  assert.equal(context.amountDigitRegions([line(['合計¥1,234'],600)],1000,1000).length,1);
  assert.equal(context.parseAmount([line(['TOTAL','1,234'],600),line(['SUBTOTAL','1,100'],640),line(['TAX','134'],680)]),1234);
  // 提供された写真のOCRと同じ、千区切り後が広い配置。
  const spaced = { words: [
    {text:'合計',box:{x0:321,x1:344,y0:641,y1:653}},
    {text:'¥4,',box:{x0:433,x1:453,y0:644,y1:654}},
    {text:'620',box:{x0:470,x1:504,y0:644,y1:655}},
  ],cy:648,avgH:11};
  assert.equal(context.parseAmount([spaced]),4620);
  spaced.words[1].text='\\4,';
  assert.equal(context.parseAmount([spaced]),4620);
  const tight=context.amountDigitRegions([spaced],715,953)[0];
  assert(tight.top*953>639); // 上の税額行の下端が639
  assert(tight.bottom*953<667); // 次の支払行の上端が667
  assert(tight.right<.75); // 写真右側の手・背景を除外
  assert(tight.left*715<433); // 先頭の4を含む
  assert.equal(context.inkThreshold(new Uint8Array([40,40,40,255,200,200,200,255])),40);
  const regions = context.amountDigitRegions([line(['合計', '620'], 600)], 1000, 1000);
  assert.equal(regions.length, 1);
  assert(regions[0].left < .045); // 数字の位置ではなくラベル直後から切り出す
  assert.equal(context.amountDigitRegions([line(['小計', '4620'], 600)], 1000, 1000).length, 0);
  assert.equal(context.amountDigitRegions([line(['合計'], 600), line(['4,620'], 640)], 1000, 1000).length, 1);
  assert.equal(context.chooseAmountReadings([{n:4620,region:0,pass:0},{n:4620,region:0,pass:1}]).amount, 4620);
  assert.equal(context.chooseAmountReadings([{n:620,region:0,pass:0},{n:4620,region:0,pass:1}]).conflict, true);
  assert.equal(context.chooseAmountReadings([{n:620,region:0,pass:0}]).confirmed, false);
  context.recognizeOne = async () => ({ text:'2026/10/04', lines:[line(['合計','620'],600)], canvas:{width:1000,height:1000} });
  context.preprocess = async () => ({width:1000,height:100});
  await handlers['#receiptInputchange']({target:{files:[{}],value:''}});
  assert.equal(elements.get('#amountInput').value, 4620);
  assert.equal(calls.filter(c => c.language === 'eng').length, 3);
  let pass = 0;
  context.recognizeCanvas = async (canvas, label) => ({text:label==='金額の確認'?(pass++===0?'620':'4620'):'',lines:[]});
  await handlers['#receiptInputchange']({target:{files:[{}],value:''}});
  assert.equal(elements.get('#amountInput').value, '');
  assert(elements.get('#ocrHint').textContent.includes('確実に読み取れません'));
  // 合計ラベルが壊れて切り出せなくても、全体OCRの金額は消さない。
  context.recognizeOne=async()=>({text:'',lines:[line(['¥1,234'],600)],canvas:{width:1000,height:1000}});
  context.recognizeCanvas=async()=>({text:'',lines:[],canvas:{width:1000,height:1000}});
  await handlers['#receiptInputchange']({target:{files:[{}],value:''}});
  assert.equal(elements.get('#amountInput').value,1234);
  assert(elements.get('#ocrHint').textContent.includes('確実に読み取れません'));
  // ラベルと金額が一語でも専用OCRへ進める。
  context.recognizeOne=async()=>({text:'',lines:[line(['合計¥1,234'],600)],canvas:{width:1000,height:1000}});
  context.recognizeCanvas=async(canvas,label)=>({text:label==='金額の確認'?'1,234':'',lines:[]});
  await handlers['#receiptInputchange']({target:{files:[{}],value:''}});
  assert.equal(elements.get('#amountInput').value,1234);
  console.log('PASS: OCR設定の適用、worker終了、全角金額、合計行/直下の切り出し、数字再OCRの画面反映、不一致の確認表示');
})().catch(error => { console.error(error); process.exitCode = 1; });
