import assert from "node:assert/strict";
import test from "node:test";

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.classes = new Set();
  }

  add(...names) {
    for (const name of names) {
      this.classes.add(name);
    }
    this.sync();
  }

  remove(...names) {
    for (const name of names) {
      this.classes.delete(name);
    }
    this.sync();
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    const next = force === undefined ? !this.classes.has(name) : Boolean(force);
    if (next) {
      this.classes.add(name);
    } else {
      this.classes.delete(name);
    }
    this.sync();
    return next;
  }

  sync() {
    this.element._className = [...this.classes].join(" ");
  }

  setFromString(value) {
    this.classes = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._className = "";
    this._textContent = "";
    this.hidden = false;
    this.isConnected = false;
  }

  set className(value) {
    this._className = String(value || "");
    this.classList.setFromString(this._className);
  }

  get className() {
    return this._className;
  }

  set textContent(value) {
    this._textContent = String(value || "");
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      node.isConnected = this.isConnected;
      this.children.push(node);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    const event = {
      target: this,
      stopPropagation: () => undefined,
    };
    let node = this;
    while (node) {
      const listener = node.listeners.get("click");
      if (listener) {
        listener(event);
      }
      node = node.parentElement;
    }
  }

  replaceWith(node) {
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    node.parentElement = parent;
    node.isConnected = this.isConnected;
    parent.children.splice(index, 1, node);
    this.parentElement = null;
    this.isConnected = false;
  }

  querySelector(selector) {
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return this.walk().find((node) => node.classList.contains(className)) ?? null;
    }
    return null;
  }

  walk() {
    return [this, ...this.children.flatMap((child) => child.walk())];
  }
}

function createContext() {
  const dock = new FakeElement("div");
  dock.isConnected = true;
  dock.className = "hidden";
  const state = {
    busy: false,
    restoringHistory: false,
    todoCollapsed: false,
    todoMarkdown: "",
    todoNode: null,
  };
  return {
    state,
    els: { todoChecklistDock: dock },
    removeWelcome: () => undefined,
    scrollMessagesToBottom: () => undefined,
    scheduleScrollRestore: () => undefined,
    copyTextToClipboard: () => undefined,
  };
}

test("todo checklist toggles when the checklist body is clicked", async () => {
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  };
  const { createMessages } = await import("../modules/messages.js");
  const ctx = createContext();
  const messages = createMessages(ctx);

  messages.renderTodoChecklist("- [ ] 첫 작업\n- [x] 끝난 작업");
  const card = ctx.els.todoChecklistDock.children[0];
  const doneLabel = card.querySelector(".todo-label");

  doneLabel.click();

  assert.equal(ctx.state.todoCollapsed, true);
  assert.equal(ctx.els.todoChecklistDock.children[0].querySelector(".todo-card-list").hidden, true);
});

test("completed todo checklist items use a visible done prefix", async () => {
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  };
  const { createMessages } = await import("../modules/messages.js");
  const ctx = createContext();
  const messages = createMessages(ctx);

  messages.renderTodoChecklist("- [x] 끝난 작업");

  const doneLabel = ctx.els.todoChecklistDock.children[0].querySelector(".todo-label");
  assert.match(doneLabel.textContent, /^\(완료\) 끝난 작업$/);
});
