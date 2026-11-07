import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { motionAllowed } from './visual-runtime';

const Leaving = createContext(false);
export const useLeaving = () => useContext(Leaving);

export function usePresence(visible: boolean, duration = 160): boolean {
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) { setMounted(true); return; }
    const timer = setTimeout(() => setMounted(false), motionAllowed() ? duration : 0);
    return () => clearTimeout(timer);
  }, [visible, duration]);
  return visible || mounted;
}

export function Presence({ visible, children }: { visible: boolean; children: ReactNode }) {
  const mounted = usePresence(visible);
  const last = useRef(children);
  if (visible) last.current = children;
  return mounted ? <Leaving.Provider value={!visible}>{visible ? children : last.current}</Leaving.Provider> : null;
}
