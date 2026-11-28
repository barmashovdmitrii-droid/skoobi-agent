import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { documentBlockReasonText, withFileDeliveryReconciliation } from './file-delivery-final.js';
import { deliverFileOnce, reconcileFileDeliveryFinal, type FileDeliveryReceipt } from './file-delivery.js';
const receipt = (state: FileDeliveryReceipt['state']): FileDeliveryReceipt => ({
  deliveryId:'fixture',state,code:'fixture',artifact:{name:'bundle.zip',sha256:'a'.repeat(64),bytes:42},
});
describe('terminal delivery facts',()=>{
  it('keeps unrelated or confirmed answers unchanged',()=>{
    expect(withFileDeliveryReconciliation('Done',[])).toBe('Done');
    expect(withFileDeliveryReconciliation('Done',[receipt('delivered')])).toBe('Done');
  });
  it('reconciles a failed attempt followed by a confirmed send of the exact same bytes',()=>{
    expect(withFileDeliveryReconciliation('Done',[receipt('blocked'),receipt('delivered')])).toBe('Done');
    expect(withFileDeliveryReconciliation('Done',[receipt('blocked'),{...receipt('delivered'),artifact:{...receipt('delivered').artifact,sha256:'b'.repeat(64)}}])).toContain('не отправлен');
  });
  it('places the actual blocked outcome ahead of model claims',()=>{
    expect(withFileDeliveryReconciliation('Файл отправлен',[receipt('blocked')])).toMatch(/^Проверка доставки:[\s\S]*файл не отправлен/);
  });
  it('does not turn an unknown outcome into a failure or permission to resend',()=>{
    const text=withFileDeliveryReconciliation('',[receipt('unknown')]);
    expect(text).toContain('исход отправки неизвестен');
    expect(text).toContain('не создать дубль');
    expect(text).not.toContain('файл не отправлен');
  });
  it('names the real reason of a blocked document in plain words (W08)',()=>{
    expect(documentBlockReasonText('acceptance_unavailable')).toBe('не прошла обязательная проверка файла');
    expect(documentBlockReasonText('checker_error')).toBe('не прошла обязательная проверка файла');
    expect(documentBlockReasonText('channel_unavailable')).toBe('нет связи с Telegram');
    expect(documentBlockReasonText('document_preflight_failed')).toBe('не получилось подготовить файл к отправке');
    expect(documentBlockReasonText('something_new')).toBe('');
    expect(withFileDeliveryReconciliation('',[{...receipt('blocked'),code:'something_new'}])).toContain('обязательная проверка или подготовка не пройдена');
  });
  it('send_document blocked in this turn → the final answer opens with the delivery check (W08)',async()=>{
    // «Архив поставлен на отправку сюда» came right after the send
    // failed; the person had to ask where the file was.
    const db=new Database(':memory:');
    try{
      const scope={sourceGroup:'telegram_main',chatJid:'tg:owner'};
      const attempt=randomUUID();
      const blocked=await deliverFileOnce({db,scope,deliveryId:randomUUID(),originAttempt:attempt,
        artifact:{name:'Игра_0.8.0.zip',bytes:3,sha256:createHash('sha256').update('zip').digest('hex')},
        send:async()=>({state:'blocked',code:'acceptance_unavailable'})});
      expect(blocked).toMatchObject({state:'blocked',code:'acceptance_unavailable'});
      const text=withFileDeliveryReconciliation('Архив поставлен на отправку сюда.',reconcileFileDeliveryFinal(db,scope,attempt));
      expect(text).toMatch(/^Проверка доставки:/);
      expect(text).toContain('«Игра_0.8.0.zip»: файл не отправлен — не прошла обязательная проверка файла.');
      expect(text.indexOf('Проверка доставки')).toBeLessThan(text.indexOf('поставлен на отправку'));
    }finally{db.close();}
  });
});
