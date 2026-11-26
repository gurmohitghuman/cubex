// The answers of the tools that do what several did before v0.8.47 (fewer MCP tools, PR C): each action answers as
// its old tool did, so each is the either of their answers (output-schema.ts eitherAnswer). A tool whose every
// action answers changed has it required, as the one shared shape (mcp/changed.ts): formula_column's from_words and
// manage_setup_version's save, rename and delete answer [] (they write no sheet data).
import { eitherAnswer, obj, open } from '../output-schema';
import { changed } from './shared';
import { controlRun as runControl, undoRun } from './runs';
import { controlSetupRun, deleteSetup, manageSetupVersion as versions, restoreSetupVersion, saveSetup } from './setups';
import { addEnrichmentField, addListRows, formulaColumn as formula, writeFormula } from './fill';
import { removeDuplicates as remove, setAutoDedupe } from './rows';
import { createDownloadLink, createUploadLink } from './read';

// A run's pause, resume, cancel or rerun (open: its type adds fields), its undo, or a setup run's.
export const controlRun = open({ ...eitherAnswer(runControl.shape, undoRun.shape, controlSetupRun.shape), changed });
// save or delete.
export const manageSetup = obj(eitherAnswer(saveSetup.shape, deleteSetup.shape));
// save, rename or delete (open: as before), or restore.
export const manageSetupVersion = open({ ...eitherAnswer(versions.shape, restoreSetupVersion.shape), changed });
// The column filled, or with from_words the formula written.
export const formulaColumn = obj({ ...eitherAnswer(formula.shape, writeFormula.shape), changed });
// The duplicates found or removed, or with keep_doing the auto-dedupe setting.
export const removeDuplicates = obj({ ...eitherAnswer(remove.shape, setAutoDedupe.shape), changed });
// add_column or add_rows.
export const storedAnswers = obj({ ...eitherAnswer(addEnrichmentField.shape, addListRows.shape), changed });
// upload or download.
export const fileLink = obj(eitherAnswer(createUploadLink.shape, createDownloadLink.shape));
