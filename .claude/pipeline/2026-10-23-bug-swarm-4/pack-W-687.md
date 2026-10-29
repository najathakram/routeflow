1e162686ae8f2229119104cd4cfe1eb722537ba3
# Row W-687: Flaky CreateOrderModal.delivery-date test

## Liveness
apps/web/app/(dashboard)/orders/_components/CreateOrderModal.delivery-date.test.tsx:127-132,163-237 user.click during dialog exit (pointer-events:none); userEvent.setup({delay:null}).

## Files / signatures
test file only: createButton(), dateField(), fake Date helper line 92

## Radius
CreateOrderModal.delivery-date.test.tsx, CreateOrderModal.tsx

## Lessons
L-258 target by role/testid; L-205 assert behavior not implementation
