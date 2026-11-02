/** 与扩展宿主之间的消息通道。acquireVsCodeApi 只能调用一次，故在此集中持有。 */
import type { HostToWebMessage, WebToHostMessage } from '../../../src/shared/types';

interface WebviewApi {
  postMessage(message: unknown): void;
}

let api: WebviewApi | null | undefined;

function resolveApi(): WebviewApi | null {
  if (api === undefined) {
    api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  }
  return api;
}

/** 页面 → 宿主。没有宿主（直接用浏览器打开构建产物）时静默忽略。 */
export function postToHost(message: WebToHostMessage): void {
  resolveApi()?.postMessage(message);
}

function isHostMessage(value: unknown): value is HostToWebMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'state' || type === 'notice' || type === 'saved';
}

/** 订阅宿主消息。只接受协议里的三种消息，其余忽略。 */
export function subscribeHost(handler: (message: HostToWebMessage) => void): void {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (isHostMessage(event.data)) {
      handler(event.data);
    }
  });
}
