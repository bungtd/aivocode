// Tests exercise sandbox policy and wrappers without creating real AppContainer
// profiles, copying the Node toolchain, or editing ACLs in parallel workers.
process.env.AIVO_DISABLE_OS_SANDBOX = "1";
