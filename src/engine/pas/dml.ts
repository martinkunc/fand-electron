// PAS: DML.PAS – server side of the DML interface for external programs (FANDDML clients). NOT PORTED.
//
// Porting notes:
// * asm/DOS: external programs started by EXEC/OSshell find CallDML through the 'DMLADDR=' env
//   variable (MEMORY.OSshell writes BaseVars._CallDMLAddr) and far-call into the running FAND with
//   parameters on the stack (the q^ record overlays); stack switching via Fand_ss/sp/bp and
//   DML_ss/sp/bp in BaseVars. No such programs can exist on the host.
// * InitDML (called by RUNFAND at start-up when FandDML is defined) only publishes the entry
//   address, so it is a no-op here; everything else is implementation-private.

// PAS: DML.PAS InitDML – _CallDMLAddr := AbsAdr(@CallDML); nothing to publish on the host
export function InitDML(): void {}
