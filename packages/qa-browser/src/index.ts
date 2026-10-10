// Building a creation and playing it in a browser (Playwright): the workbench runs the `ats-qa`
// command, and the server runs `checkProject` itself only in development, without a supervisor.
export {
  type CheckOptions,
  type CheckResult,
  checkProject,
  readReport,
  type Step,
} from './pipeline.ts';
