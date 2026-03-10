-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
