'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@routeflow/ui/web';
import { connectSocket, disconnectSocket } from '../socket';

export function useRealtimeUpdates() {
  const qc = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const token = localStorage.getItem('accessToken');
    if (!token) return;

    const socket = connectSocket(token);

    socket.on('route.stop.completed', () => {
      void qc.invalidateQueries({ queryKey: ['routes'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    });

    socket.on('order.urgent.placed', (data: { orderNumber: string; customerName: string }) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      toast({
        title: 'Urgent order placed',
        description: `${data.customerName} — order ${data.orderNumber}`,
        variant: 'destructive',
      });
    });

    socket.on('driver.status.updated', (data: { driverName: string; status: string }) => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
      toast({
        title: 'Driver status changed',
        description: `${data.driverName} is now ${data.status.toLowerCase()}`,
      });
    });

    socket.on('inventory.low.stock', (data: { productName: string; stockLevel: number }) => {
      void qc.invalidateQueries({ queryKey: ['products'] });
      toast({
        title: 'Low stock alert',
        description: `${data.productName} — only ${data.stockLevel} units remaining`,
        variant: 'destructive',
      });
    });

    return () => {
      socket.off('route.stop.completed');
      socket.off('order.urgent.placed');
      socket.off('driver.status.updated');
      socket.off('inventory.low.stock');
      disconnectSocket();
    };
  }, [qc, toast]);
}
