#!/usr/bin/env bash
# A whole sharded cluster in one container, for the opt-in sharded suite
# (tests/integration/sharded.test.js): a one-node config server replica set,
# two one-node shard replica sets and a mongos on 27017 — with access control
# on (a keyfile), so the suite can also check what a restricted user may read.
# A 1 MB chunk size makes a few thousand documents split into many chunks.
#
#   docker run --rm -d --name migronaut-sharded -p 27019:27017 \
#     -v "$PWD/tests/fixtures/sharded:/s:ro" mongo:8.0 bash /s/start.sh
#   MIGRONAUT_TEST_SHARDED_URI="mongodb://root:root@127.0.0.1:27019/?authSource=admin" \
#     node --test tests/integration/sharded.test.js
#
# Test-only credentials (root/root): the container is throwaway and local.
set -euo pipefail

# Everything runs as root: the container is throwaway, and the keyfile must
# belong to whoever runs the servers.
mkdir -p /data/cfg /data/s1 /data/s2
openssl rand -base64 756 > /data/keyfile
chmod 400 /data/keyfile

# Resharding (and 8.0 moveCollection, built on it) runs at least 5 minutes by
# default — far too long for a probe.
FAST_RESHARD='reshardingMinimumOperationDurationMillis=1000'
mongod --configsvr --replSet cfg --port 27100 --dbpath /data/cfg --bind_ip_all \
  --keyFile /data/keyfile --setParameter "$FAST_RESHARD" --fork --logpath /data/cfg.log
mongod --shardsvr --replSet s1 --port 27101 --dbpath /data/s1 --bind_ip_all \
  --keyFile /data/keyfile --setParameter "$FAST_RESHARD" --fork --logpath /data/s1.log
mongod --shardsvr --replSet s2 --port 27102 --dbpath /data/s2 --bind_ip_all \
  --keyFile /data/keyfile --setParameter "$FAST_RESHARD" --fork --logpath /data/s2.log

# The localhost exception lets each replica set be initiated before any user exists.
mongosh --quiet --port 27100 --eval \
  "rs.initiate({ _id: 'cfg', configsvr: true, members: [{ _id: 0, host: 'localhost:27100' }] })"
mongosh --quiet --port 27101 --eval \
  "rs.initiate({ _id: 's1', members: [{ _id: 0, host: 'localhost:27101' }] })"
mongosh --quiet --port 27102 --eval \
  "rs.initiate({ _id: 's2', members: [{ _id: 0, host: 'localhost:27102' }] })"
for port in 27100 27101 27102; do
  until mongosh --quiet --port "$port" --eval 'db.hello().isWritablePrimary' | grep -q true; do
    sleep 0.5
  done
done

mongos --configdb cfg/localhost:27100 --port 27017 --bind_ip_all \
  --keyFile /data/keyfile --fork --logpath /data/mongos.log
until mongosh --quiet --port 27017 --eval 'db.adminCommand({ ping: 1 }).ok' | grep -q 1; do
  sleep 0.5
done

# The first user, through the localhost exception of the mongos.
mongosh --quiet --port 27017 --eval \
  "db.getSiblingDB('admin').createUser({ user: 'root', pwd: 'root', roles: ['root'] })"
mongosh --quiet --port 27017 -u root -p root --authenticationDatabase admin --eval "
  sh.addShard('s1/localhost:27101');
  sh.addShard('s2/localhost:27102');
  db.getSiblingDB('config').settings.updateOne(
    { _id: 'chunksize' }, { \$set: { value: 1 } }, { upsert: true });
"

echo 'migronaut sharded cluster ready'
exec tail -F /data/mongos.log
