// The web identity can execute this one job. It cannot update the job, read its
// provisioner secret, or administer database roles itself.
let lastAttempt = 0;
export async function triggerProvisioning(options: { force?: boolean } = {}): Promise<void> {
  const job = process.env.ENGRAM_PROVISION_JOB;
  if (!job || !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/engram-provision$/.test(job)) return;
  if (!options.force && Date.now()-lastAttempt < 15_000) return;
  lastAttempt = Date.now();
  try {
    const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",{headers:{"Metadata-Flavor":"Google"},signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error();
    const identity = await response.json() as {access_token?:string};
    if (!identity.access_token) throw new Error();
    const run = await fetch(`https://run.googleapis.com/v2/${job}:run`,{method:"POST",headers:{Authorization:`Bearer ${identity.access_token}`,"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(5000)});
    if (!run.ok) throw new Error();
  } catch { console.warn("[provisioning] Workspace setup remains queued; the provisioner will retry"); }
}
