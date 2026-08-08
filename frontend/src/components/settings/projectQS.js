// Project-scoped query-string helper.
// Shared by the settings views that need to append ?projectDir=... to a
// REST URL or a #/ settings route. Returns '' when no project is active
// so the call/route stays app-scoped.
export function projectQS(projectDir) {
  return projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
}