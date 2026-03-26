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

    socket.on('connect_error', (err) => {
      console.error('[WS] connect_error:', err.message);
      toast({
        title: 'Real-time connection failed',
        description: 'Live updates may be unavailable. Retrying…',
        variant: 'error',
      });
    });

    socket.on('route.stop.completed', () => {
      void qc.invalidateQueries({ queryKey: ['routes'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    });

    socket.on('order.created', (data: { orderNumber: string; customerName: string; urgent: boolean }) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast({
        title: data.urgent ? '🚨 Urgent order placed' : 'New order placed',
        description: `${data.customerName} — order ${data.orderNumber}`,
        variant: data.urgent ? 'error' : 'default',
      });
    });

    socket.on('order.urgent.placed', (data: { orderNumber: string; customerName: string }) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      toast({
        title: 'Urgent order placed',
        description: `${data.customerName} — order ${data.orderNumber}`,
        variant: 'error',
      });
    });

    socket.on('order.statusChanged', (data: { orderId: string; orderNumber: string; status: string }) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['orders', data.orderId] });
    });

    socket.on('driver.status.updated', (data: { driverName: string; status: string }) => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
      void qc.invalidateQueries({ queryKey: ['routes'] });
      toast({
        title: 'Driver status changed',
        description: `${data.driverName} is now ${data.status.toLowerCase()}`,
      });
    });

    socket.on('inventory.low.stock', (data: { productName: string; stockLevel: number }) => {
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      toast({
        title: 'Low stock alert',
        description: `${data.productName} — only ${data.stockLevel} units remaining`,
        variant: 'error',
      });
    });

    socket.on('return.created', (data: { customerName: string; reason: string }) => {
      void qc.invalidateQueries({ queryKey: ['returns'] });
      toast({
        title: 'New return submitted',
        description: `${data.customerName} — reason: ${data.reason}`,
      });
    });

    socket.on('invoice.updated', (data: { invoiceNumber: string; invoiceId: string; status: string }) => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['invoices', data.invoiceId] });
    });

    socket.on('creditNote.created', (data: { creditNoteNumber: string; creditNoteId: string }) => {
      void qc.invalidateQueries({ queryKey: ['credit-notes'] });
      void qc.invalidateQueries({ queryKey: ['credit-notes', data.creditNoteId] });
    });

    return () => {
      socket.off('connect_error');
      socket.off('route.stop.completed');
      socket.off('order.created');
      socket.off('order.urgent.placed');
      socket.off('order.statusChanged');
      socket.off('driver.status.updated');
      socket.off('inventory.low.stock');
      socket.off('return.created');
      socket.off('invoice.updated');
      socket.off('creditNote.created');
      disconnectSocket();
    };
  }, [qc, toast]);
}
