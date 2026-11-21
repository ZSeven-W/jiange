/**
 * Optional zero-bundle-cost React adapter factory for `@jiange/doc-ui`.
 * Call `createDocViewComponent(React)` to obtain a React component without
 * pulling React into vanilla/Vue/Svelte bundles.
 */

import type { Document } from "@jiange/doc-sdk";
import { mountDocView, type DocViewOptions, type MountedDocView } from "./doc-view.js";

export interface DocReactLike {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  createElement(type: string, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

export interface DocViewProps extends DocViewOptions {
  document: Document;
  width?: number;
  height?: number;
  className?: string;
}

export function createDocViewComponent(React: DocReactLike): (props: DocViewProps) => unknown {
  return function DocView(props: DocViewProps) {
    const hostRef = React.useRef<HTMLElement | null>(null);
    const viewRef = React.useRef<MountedDocView | null>(null);
    React.useEffect(() => {
      const el = hostRef.current;
      if (!el) return;
      const view = mountDocView(el, props.document, props);
      viewRef.current = view;
      return () => {
        view.dispose();
        viewRef.current = null;
      };
    }, [props.document]);
    return React.createElement("div", {
      ref: hostRef,
      tabIndex: 0,
      className: props.className,
      style: {
        width: props.width ? `${props.width}px` : "100%",
        height: props.height ? `${props.height}px` : "100%",
      },
    });
  };
}
