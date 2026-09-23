// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

/**
 * A transient status message that auto-dismisses after a short delay. Each new
 * message resets the timer, and the pending timer is cleared on unmount.
 */
export function useActionNotice(durationMs = 1800): {
  readonly actionNotice: string | undefined;
  readonly showActionNotice: (message: string) => void;
} {
  const [actionNotice, setActionNotice] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );
  const showActionNotice = (message: string): void => {
    setActionNotice(message);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => setActionNotice(undefined), durationMs);
  };
  return { actionNotice, showActionNotice };
}
