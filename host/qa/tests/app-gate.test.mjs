// 测试:原生 App 环境门槛(fail-closed)。网页端放行;原生 App 缺环境即拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNativeAppEnd, platformOf, checkMobileEnv, assertAppEnvGate } from '../app-gate.mjs';

test('识别端类型', () => {
  assert.equal(isNativeAppEnd('用户端'), false);
  assert.equal(isNativeAppEnd('运营后台'), false);
  assert.equal(isNativeAppEnd('安卓App'), true);
  assert.equal(isNativeAppEnd('iOS App'), true);
  assert.equal(platformOf('安卓App'), 'android');
  assert.equal(platformOf('iOS App'), 'ios');
});

test('网页端 → 门槛直接放行(web:true)', () => {
  const r = assertAppEnvGate('用户端', {});
  assert.equal(r.web, true);
});

test('原生 App + 无环境 → 抛 app_env_not_ready(fail-closed)', () => {
  try {
    assertAppEnvGate('安卓App', {}); // 空 env
    assert.fail('应抛错');
  } catch (e) {
    assert.equal(e.code, 'app_env_not_ready');
  }
});

test('原生 App + 环境齐 → 放行(web:false + platform)', () => {
  const env = { APPIUM_URL: 'http://127.0.0.1:4723', ANDROID_HOME: '/opt/android' };
  const r = assertAppEnvGate('安卓App', env);
  assert.equal(r.web, false);
  assert.equal(r.platform, 'android');
});

test('checkMobileEnv 报出缺什么', () => {
  const r = checkMobileEnv('android', {});
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes('APPIUM_URL'));
  assert.ok(r.missing.includes('ANDROID_HOME'));
});
