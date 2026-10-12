// Tests unitaires de la vérification de la chaîne d'audit après restauration (docs/13 D10) : `node --test test/`.
// Les empreintes attendues ont été calculées par l'implémentation de l'API (apps/api/src/common/audit/audit-chain.ts) :
// toute divergence de la canonicalisation entre l'API et l'outil de restauration fait échouer ce test.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, firstBrokenSeq } from '../audit-chain.mjs';

const H1 = '425533c24a682acaaa211388c5554293ca67182a4c8ce1bff0df1a4f75000525';
const H2 = 'e36f77629fbbcf62aa3ed0cea96a2e9c279ee4f378fa26ae053d9d7bc33dfe7a';
const GENESIS = Buffer.alloc(32);

/** Lignes telles que les renvoie `pg` (int8 en texte, timestamptz en Date, bytea en Buffer, jsonb en objet). */
function rows() {
  const first = {
    tenant_id: '0190a1b2-0000-7000-8000-000000000001',
    chain_seq: '1',
    occurred_at: new Date('2026-10-11T08:30:00.123Z'),
    actor_type: 'user',
    actor_user_id: '0190a1b2-0000-7000-8000-0000000000aa',
    session_id: null,
    ip: '127.0.0.1',
    action: 'iam.user.created',
    resource_type: 'user',
    resource_id: '0190a1b2-0000-7000-8000-0000000000bb',
    patient_id: null,
    outcome: 'success',
    changes: { z: 1, a: { b: [1, 'é', null], a: true } },
    request_id: 'req-12345678',
    prev_hash: GENESIS,
    hash: Buffer.from(H1, 'hex'),
  };
  const second = {
    ...first,
    chain_seq: '2',
    occurred_at: new Date('2026-10-11T08:31:00.000Z'),
    action: 'auth.login.succeeded',
    changes: null,
    ip: null,
    prev_hash: Buffer.from(H1, 'hex'),
    hash: Buffer.from(H2, 'hex'),
  };
  return [first, second];
}

describe('canonicalJson', () => {
  it('trie les clés récursivement et ignore les valeurs undefined', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [true, null] } }), '{"a":{"c":[true,null]},"b":1}');
  });
});

describe('firstBrokenSeq', () => {
  it('accepte une chaîne intacte produite par l’API', () => {
    assert.equal(firstBrokenSeq(rows()), null);
  });

  it('accepte une chaîne vide', () => {
    assert.equal(firstBrokenSeq([]), null);
  });

  it('signale un maillon dont le contenu a été modifié', () => {
    const [first, second] = rows();
    assert.equal(firstBrokenSeq([first, { ...second, action: 'auth.login.failed' }]), '2');
  });

  it('signale un maillon manquant (rupture de séquence)', () => {
    const [first, second] = rows();
    assert.equal(firstBrokenSeq([first, { ...second, chain_seq: '3' }]), '3');
  });

  it('signale un premier maillon qui ne part pas de l’empreinte d’origine', () => {
    const [first] = rows();
    assert.equal(firstBrokenSeq([{ ...first, prev_hash: Buffer.alloc(32, 1) }]), '1');
  });
});
