// Opening the report from the end screen: poll /report_status until done, then open
// /sessions/<id>/report.html in the same tab.

import { api, reportUrl } from '../api';
import { sleep } from './dom';

export async function waitForReport(id: string, onStage: (stage: string) => void, pollMs = 1000, maxMs = 15 * 60_000): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const st = await api.reportStatus(id);
      onStage(st.stage);
      if (st.done) return st.report_html ?? reportUrl(id);
      if (st.stage === 'error') { onStage(`error: ${st.error ?? 'unknown'}`); return null; }
    } catch {
      onStage('waiting for the back end');
    }
    await sleep(pollMs);
  }
  return null;
}

export async function openReport(id: string, onStage: (stage: string) => void): Promise<boolean> {
  const url = await waitForReport(id, onStage);
  if (!url) return false;
  window.location.assign(url);
  return true;
}
