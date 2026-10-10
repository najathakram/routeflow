### UI-865 — admin EnableAddonModal shows the no-catalog-SKU 400 (SA-277a)

Test-only unless it fails: add one RTL case to `EnableAddonModal.test.tsx` — the enable call rejects with `{response:{data:{message:'Add-on "X" has no catalog SKU to price — publish a catalog version defining "X" before billing it'}}}` → that exact text is rendered in the modal's error region, the modal stays open, and the submit button is re-enabled. If the modal already passes (it renders `response.data.message`, :94-103), change NO source file. Run: `npm test -w apps/web -- EnableAddonModal --maxWorkers=2`.
