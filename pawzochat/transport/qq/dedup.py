"""Bounded, account-scoped duplicate admission before any inbound effects."""

import threading
import time
from collections import OrderedDict


class EventDeduplicator:
    def __init__(self, ttl=3600, capacity=10_000, clock=time.monotonic):
        self.ttl, self.capacity, self.clock = ttl, capacity, clock
        self._lock = threading.Lock()
        self._pending = {}
        self._done = {}

    def reserve(self, account_id, event_id):
        if not event_id:
            return object()
        key = (account_id, event_id)
        with self._lock:
            done = self._done.setdefault(account_id, OrderedDict())
            now = self.clock()
            while done and next(iter(done.values())) <= now - self.ttl:
                done.popitem(last=False)
            if key in self._pending or event_id in done:
                return None
            ticket = object()
            self._pending[key] = ticket
            return ticket

    def finish(self, account_id, event_id, ticket, success):
        key = (account_id, event_id)
        with self._lock:
            if self._pending.get(key) is not ticket:
                return
            del self._pending[key]
            if success:
                done = self._done.setdefault(account_id, OrderedDict())
                done[event_id] = self.clock()
                while len(done) > self.capacity:
                    done.popitem(last=False)

    def remove_account(self, account_id):
        with self._lock:
            self._done.pop(account_id, None)
            for key in list(self._pending):
                if key[0] == account_id:
                    del self._pending[key]
