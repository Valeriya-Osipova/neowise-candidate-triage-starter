const TOPIC_LABELS = {
  delivery: "Доставка",
  pricing: "Стоимость",
  other: "Другое",
};

const INVALID_MESSAGE = "Введите текст заявки. Сообщение из одних пробелов не отправляется на разбор.";
const MANUAL_MESSAGE = "Автоматический разбор не удался. Заявка сохранена, предыдущий черновик очищен. Напишите ответ вручную — клиенту ничего не отправлено.";

export function validateInput(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, message: INVALID_MESSAGE };
  }
  return { ok: true, text: text.trim() };
}

function idleView() {
  return {
    phase: "idle",
    message: "",
    topicLabel: "",
    draft: "",
    source: "",
    showPanel: false,
    loading: false,
  };
}

function invalidView() {
  return {
    phase: "invalid",
    message: INVALID_MESSAGE,
    topicLabel: "",
    draft: "",
    source: "",
    showPanel: false,
    loading: false,
  };
}

function loadingView(source) {
  return {
    phase: "loading",
    message: "Разбираем заявку…",
    topicLabel: "",
    draft: "",
    source,
    showPanel: true,
    loading: true,
  };
}

function readyView(body, source) {
  return {
    phase: "ready",
    message: "Черновик готов. Проверьте текст и при необходимости исправьте его. Клиенту ничего не отправлено.",
    topicLabel: TOPIC_LABELS[body.topic],
    draft: body.draft.trim(),
    source,
    showPanel: true,
    loading: false,
  };
}

function manualView(source) {
  return {
    phase: "manual",
    message: MANUAL_MESSAGE,
    topicLabel: "",
    draft: "",
    source,
    showPanel: true,
    loading: false,
  };
}

function isReadyBody(body) {
  return (
    body?.status === "ready" &&
    Object.hasOwn(TOPIC_LABELS, body.topic) &&
    typeof body.draft === "string" &&
    body.draft.trim() !== ""
  );
}

function applyHttp(response, source) {
  const body = response?.body;
  if (response?.status === 400 || body?.status === "invalid_input") return invalidView();
  if (isReadyBody(body)) return readyView(body, source);
  return manualView(source);
}

export function createController() {
  let latestId = 0;
  let view = idleView();

  function isCurrent(id) {
    return id === latestId;
  }

  return {
    get view() {
      return view;
    },
    rejectInput() {
      if (view.loading) return view;
      view = invalidView();
      return view;
    },
    start(source) {
      latestId += 1;
      view = loadingView(source);
      return latestId;
    },
    settle(id, response, source) {
      if (!isCurrent(id)) return false;
      view = applyHttp(response, source);
      return true;
    },
    fail(id, source) {
      if (!isCurrent(id)) return false;
      view = manualView(source);
      return true;
    },
  };
}
