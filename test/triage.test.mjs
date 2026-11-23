import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../mock-ai.mjs";
import { createController, validateInput } from "../client-state.mjs";
import { createApp } from "../server.mjs";
import { triageText } from "../triage.mjs";

const MANUAL = { status: "manual_review", topic: null, draft: null };

function ready(topic, draft) {
  return JSON.stringify({ topic, draft });
}

async function withServer(fn, options) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function post(base, body, { raw = false } = {}) {
  const response = await fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("пробелы не уходят в модель и получают invalid_input", async () => {
  let called = false;
  const result = await triageText(" \n\t ", {
    timeoutMs: 20,
    classifyFn() {
      called = true;
      return ready("other", "не должен появиться");
    },
  });
  assert.equal(called, false);
  assert.equal(result.httpStatus, 400);
  assert.deepEqual(result.body, { status: "invalid_input" });
  assert.equal(validateInput("   ").ok, false);
});

test("корректный ответ модели становится готовым черновиком", async () => {
  const result = await triageText("  Когда будет доставка заказа?  ", {
    classifyFn: classify,
    timeoutMs: 50,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "ready");
  assert.equal(result.body.topic, "delivery");
  assert.equal(typeof result.body.draft, "string");
  assert.ok(result.body.draft.trim().length > 0);
});

test("лишние поля модели не попадают в ответ", async () => {
  const result = await triageText("обычный вопрос", {
    timeoutMs: 20,
    classifyFn(text) {
      assert.equal(text, "обычный вопрос");
      return JSON.stringify({ topic: "pricing", draft: "  Назовём стоимость.  ", secret: "hidden" });
    },
  });
  assert.deepEqual(result.body, { status: "ready", topic: "pricing", draft: "Назовём стоимость." });
});

test("неизвестная тема и черновик из пробелов уходят в ручной разбор", async () => {
  const topic = await triageText("верните деньги [bad-topic]", { classifyFn: classify, timeoutMs: 50 });
  const draft = await triageText("пустой ответ [empty-draft]", { classifyFn: classify, timeoutMs: 50 });
  assert.deepEqual(topic.body, MANUAL);
  assert.deepEqual(draft.body, MANUAL);
  assert.equal(topic.httpStatus, 200);
  assert.equal(draft.httpStatus, 200);
});

test("ошибка модели и некорректный JSON не выглядят как успешный разбор", async () => {
  const broken = await triageText("сломанный ответ [bad-json]", { classifyFn: classify, timeoutMs: 50 });
  const failed = await triageText("сервис лёг [error]", { classifyFn: classify, timeoutMs: 50 });
  assert.deepEqual(broken.body, MANUAL);
  assert.deepEqual(failed.body, MANUAL);
});

test("таймаут возвращает ручной разбор, не дожидаясь имитатора", async () => {
  const started = Date.now();
  const result = await triageText("подожди [timeout]", { classifyFn: classify, timeoutMs: 30 });
  const elapsed = Date.now() - started;
  assert.deepEqual(result.body, MANUAL);
  assert.ok(elapsed < 800, `ожидание заняло ${elapsed} мс`);
});

test("таймаут срабатывает, даже если модель игнорирует отмену", async () => {
  const started = Date.now();
  const result = await triageText("долгий текст", {
    timeoutMs: 20,
    classifyFn() {
      return new Promise(() => {});
    },
  });
  assert.deepEqual(result.body, MANUAL);
  assert.ok(Date.now() - started < 400);
});

test("сбой очищает старый черновик и открывает ручную обработку", () => {
  const ui = createController();
  const first = ui.start("старая заявка");
  ui.settle(first, { status: 200, body: { status: "ready", topic: "delivery", draft: "Старый черновик" } }, "старая заявка");
  assert.equal(ui.view.draft, "Старый черновик");

  const second = ui.start("новая заявка про цену");
  assert.equal(ui.view.loading, true);
  assert.equal(ui.view.draft, "");
  assert.equal(ui.view.topicLabel, "");

  const applied = ui.settle(second, { status: 200, body: MANUAL }, "новая заявка про цену");
  assert.equal(applied, true);
  assert.equal(ui.view.phase, "manual");
  assert.equal(ui.view.loading, false);
  assert.equal(ui.view.draft, "");
  assert.equal(ui.view.topicLabel, "");
  assert.equal(ui.view.source, "новая заявка про цену");
  assert.match(ui.view.message, /вручную/);
  assert.equal(ui.view.showPanel, true);
});

test("пустой ввод после готового черновика убирает устаревший результат", () => {
  const ui = createController();
  const id = ui.start("доставка");
  ui.settle(id, { status: 200, body: { status: "ready", topic: "delivery", draft: "Старый черновик" } }, "доставка");
  ui.rejectInput();
  assert.equal(ui.view.phase, "invalid");
  assert.equal(ui.view.draft, "");
  assert.equal(ui.view.showPanel, false);
  assert.match(ui.view.message, /пробел/);
});

test("ответ более раннего запроса не затирает актуальный результат", () => {
  const ui = createController();
  const first = ui.start("первая заявка");
  const second = ui.start("вторая заявка");
  assert.equal(ui.view.draft, "");
  assert.equal(ui.view.loading, true);

  assert.equal(
    ui.settle(first, { status: 200, body: { status: "ready", topic: "delivery", draft: "устаревший черновик" } }, "первая заявка"),
    false,
  );
  assert.equal(ui.fail(first, "первая заявка"), false);
  assert.equal(ui.view.phase, "loading");
  assert.equal(ui.view.draft, "");
  assert.equal(ui.view.source, "вторая заявка");

  assert.equal(
    ui.settle(second, { status: 200, body: { status: "ready", topic: "other", draft: "актуальный черновик" } }, "вторая заявка"),
    true,
  );
  assert.equal(ui.view.phase, "ready");
  assert.equal(ui.view.draft, "актуальный черновик");
  assert.equal(ui.view.loading, false);
  assert.equal(ui.view.source, "вторая заявка");
});

test("сетевой сбой текущего запроса снимает ожидание и просит ручной разбор", () => {
  const ui = createController();
  const id = ui.start("заявка без связи");
  assert.equal(ui.fail(id, "заявка без связи"), true);
  assert.equal(ui.view.loading, false);
  assert.equal(ui.view.phase, "manual");
  assert.equal(ui.view.draft, "");
  assert.equal(ui.view.source, "заявка без связи");
});

test("HTTP-контракт: пустой ввод, успех, битый JSON и сбой модели", async () => {
  await withServer(async (base) => {
    const spaces = await post(base, { text: "   " });
    assert.equal(spaces.status, 400);
    assert.deepEqual(spaces.body, { status: "invalid_input" });

    const missing = await post(base, {});
    assert.deepEqual(missing.body, { status: "invalid_input" });

    const notString = await post(base, { text: 12 });
    assert.equal(notString.status, 400);

    const broken = await post(base, "{", { raw: true });
    assert.equal(broken.status, 400);
    assert.deepEqual(broken.body, { status: "invalid_input" });

    const ok = await post(base, { text: "Какая стоимость доставки?" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "ready");
    assert.equal(ok.body.topic, "pricing");
    assert.ok(ok.body.draft.trim().length > 0);

    const failed = await post(base, { text: "проверка [error]" });
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.body, MANUAL);

    const badTopic = await post(base, { text: "проверка [bad-topic]" });
    assert.deepEqual(badTopic.body, MANUAL);

    const emptyDraft = await post(base, { text: "проверка [empty-draft]" });
    assert.deepEqual(emptyDraft.body, MANUAL);
  }, { timeoutMs: 40 });
});
