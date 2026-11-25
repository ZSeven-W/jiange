/**
 * Optional zero-bundle-cost React adapter factory for `@zseven-w/base-ui`.
 * Call `createBaseViewComponent(React)` to obtain a React component without
 * pulling React into vanilla/Vue/Svelte bundles.
 */

import type { Base } from "@zseven-w/base-sdk";
import { mountBaseView, type BaseViewOptions, type MountedBaseView } from "./base-view.js";

export interface BaseReactLike {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  createElement(type: string, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

export interface BaseViewProps extends BaseViewOptions {
  base: Base;
  width?: number;
  height?: number;
  className?: string;
}

export function createBaseViewComponent(React: BaseReactLike): (props: BaseViewProps) => unknown {
  return function BaseView(props: BaseViewProps) {
    const hostRef = React.useRef<HTMLElement | null>(null);
    React.useEffect(() => {
      let alive = true;
      let mounted: MountedBaseView | null = null;
      const el = hostRef.current;
      if (!el) return;
      void mountBaseView(el, props.base, props).then((v) => {
        if (!alive) v.dispose();
        else mounted = v;
      });
      return () => {
        alive = false;
        mounted?.dispose();
      };
    }, [props.base, props.tableId, props.mode]);
    return React.createElement("div", {
      ref: hostRef,
      className: props.className,
      style: {
        width: props.width ? `${props.width}px` : "100%",
        height: props.height ? `${props.height}px` : "100%",
      },
    });
  };
}
