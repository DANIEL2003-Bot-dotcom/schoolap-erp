import 'dart:async';
import 'dart:convert';

import 'package:ecole_mobile/main.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'helpers.dart';

void main() {
  late LocalDb db;
  late FakeServer server;
  late FakeConnectivity net;
  late ApiClient api;
  late SyncEngine engine;
  late List<Student> students;
  var unauthorized = 0;
  final today = isoDate(DateTime.now());

  setUp(() async {
    db = await openTestDb();
    students = await seedLocal(db);
    server = FakeServer();
    net = FakeConnectivity(online: false);
    api = ApiClient(baseUrl: 'http://api.test/', client: server.client)..token = 'jeton';
    unauthorized = 0;
    engine = SyncEngine(db: db, api: api, connectivity: net, onUnauthorized: () => unauthorized++);
    await engine.start();
  });

  tearDown(() async {
    engine.dispose();
    await db.close();
  });

  Future<Map<String, Object?>> attendanceRow(String studentId) async =>
      (await db.db.query('attendance', where: 'student_id = ?', whereArgs: [studentId])).single;

  test('enregistrement local : is_synced = 0 et une seule entrée de file par élève', () async {
    await db.saveAttendance(student: students[0], date: today, isPresent: true);
    await db.saveAttendance(student: students[0], date: today, isPresent: false);
    final row = await attendanceRow(students[0].id);
    expect(row['is_synced'], 0);
    expect(row['status'], 'ABSENT');
    final outbox = await db.db.query('outbox');
    expect(outbox, hasLength(1));
    final payload = jsonDecode(outbox.single['payload'] as String) as Map<String, dynamic>;
    expect(payload['isPresent'], false);
    expect(payload['id'], row['id']);
    expect(DateTime.parse(payload['clientUpdatedAt'] as String).isUtc, isTrue);
  });

  test('hors ligne : rien n’est envoyé ; retour du réseau : lot envoyé et accusé', () async {
    await db.saveAttendance(student: students[0], date: today, isPresent: false);
    await db.saveAttendance(student: students[1], date: today, isPresent: true);
    await engine.syncNow();
    expect(server.requests, isEmpty);
    await engine.refreshCounts();
    expect(engine.pendingAttendance, 2);

    net.set(true);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    await engine.syncNow();

    expect(server.requests, hasLength(1));
    expect(server.requests.single.url.toString(), 'http://api.test/api/attendance/sync');
    expect(server.requests.single.headers['Authorization'], 'Bearer jeton');
    expect(server.recordsOf(0), hasLength(2));
    expect((await attendanceRow(students[0].id))['is_synced'], 1);
    expect((await attendanceRow(students[0].id))['sms_status'], 'sent');
    expect(await db.db.query('outbox'), isEmpty);
    expect(engine.pendingTotal, 0);
    expect(engine.lastSmsSent, 1);
  });

  test('modification pendant l’envoi : la ligne reste locale et la nouvelle version repart', () async {
    net.set(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await engine.syncNow();
    await db.saveAttendance(student: students[0], date: today, isPresent: true);
    server.gate = Completer<void>();
    final inFlight = engine.syncNow();
    await Future<void>.delayed(const Duration(milliseconds: 50));
    await db.saveAttendance(student: students[0], date: today, isPresent: false); // l'enseignant corrige
    server.gate!.complete();
    server.gate = null;
    await inFlight;

    final afterFirst = await attendanceRow(students[0].id);
    expect(afterFirst['status'], 'ABSENT');
    // Même cycle : l'accusé de l'ancienne version n'a pas validé la nouvelle, qui est repartie aussitôt.
    expect(server.recordsOf(server.requests.length - 2).single['isPresent'], true);
    await engine.syncNow();
    expect(server.recordsOf(server.requests.length - 1).single['isPresent'], false);
    expect((await attendanceRow(students[0].id))['is_synced'], 1);
    expect(await db.db.query('outbox'), isEmpty);
  });

  test('erreur 503 : backoff, puis succès après reprise', () async {
    net.set(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    server.override = (_) => jsonResponse(503, {'error': {'code': 'UNAVAILABLE', 'message': 'Service indisponible'}});
    await db.saveAttendance(student: students[0], date: today, isPresent: true);
    await engine.syncNow();
    final row = (await db.db.query('outbox')).single;
    expect(row['attempts'], 1);
    expect(row['next_attempt_at'] as int, greaterThan(DateTime.now().millisecondsSinceEpoch));
    expect(engine.lastError, 'Service indisponible');
    expect((await attendanceRow(students[0].id))['is_synced'], 0);

    // Tant que le délai n'est pas écoulé, aucune nouvelle requête
    final count = server.requests.length;
    await engine.syncNow();
    expect(server.requests.length, count);

    server.override = null;
    await db.resetBackoff();
    await engine.syncNow();
    expect((await attendanceRow(students[0].id))['is_synced'], 1);
  });

  test('backoff exponentiel plafonné', () {
    expect(engine.backoffMs(1), inInclusiveRange(5000, 6000));
    expect(engine.backoffMs(2), inInclusiveRange(10000, 11000));
    expect(engine.backoffMs(30), lessThanOrEqualTo(15 * 60 * 1000 + 1000));
  });

  test('rejet par enregistrement : erreur affichée, retiré de la file', () async {
    net.set(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    server.override = (req) {
      final records = ((jsonDecode(req.body) as Map)['records'] as List);
      return jsonResponse(200, {
        'success': true,
        'summary': {'smsSent': 0},
        'results': [
          {'index': 0, 'id': records[0]['id'], 'result': 'created', 'sms': 'not_required'},
          {
            'index': 1,
            'id': records[1]['id'],
            'result': 'rejected',
            'errors': [
              {'field': 'studentId', 'message': 'Cet élève n’appartient pas à vos classes.'}
            ],
          },
        ],
      });
    };
    await db.saveAttendance(student: students[0], date: today, isPresent: true);
    await db.saveAttendance(student: students[1], date: today, isPresent: true);
    await engine.syncNow();
    final entries = await db.attendanceFor(classId, today);
    expect(entries[students[0].id]!.state, SyncState.synced);
    expect(entries[students[1].id]!.state, SyncState.error);
    expect(entries[students[1].id]!.syncError, contains('n’appartient pas'));
    expect(await db.db.query('outbox'), isEmpty);
  });

  test('400 global avec détails par index', () async {
    net.set(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    server.override = (_) => jsonResponse(400, {
          'error': {
            'code': 'VALIDATION_ERROR',
            'message': 'Aucune présence valide dans la requête.',
            'details': [
              {
                'index': 0,
                'result': 'rejected',
                'errors': [
                  {'message': 'Date dans le futur.'}
                ]
              }
            ],
          }
        });
    await db.saveAttendance(student: students[2], date: today, isPresent: false);
    await engine.syncNow();
    final entry = (await db.attendanceFor(classId, today))[students[2].id]!;
    expect(entry.state, SyncState.error);
    expect(entry.syncError, 'Date dans le futur.');
  });

  test('401 : envoi suspendu, données conservées, reconnexion demandée', () async {
    net.set(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    server.override = (_) => jsonResponse(401, {'error': {'code': 'UNAUTHORIZED', 'message': 'Session expirée'}});
    await db.saveAttendance(student: students[0], date: today, isPresent: true);
    await engine.syncNow();
    expect(unauthorized, 1);
    expect(await db.db.query('outbox'), hasLength(1));
    final count = server.requests.length;
    await engine.syncNow();
    expect(server.requests.length, count, reason: 'aucun envoi tant que la session est expirée');
  });

  test('serveur injoignable (exception réseau)', () async {
    net.set(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    server.override = (_) => throw http.ClientException('Connection refused');
    await db.saveAttendance(student: students[0], date: today, isPresent: true);
    await engine.syncNow();
    expect(engine.serverReachable, isFalse);
    expect((await db.db.query('outbox')).single['attempts'], 1);
  });

  test('cotes : validation locale et envoi vers /api/grades/sync', () async {
    expect(
      () => db.saveGrade(studentId: students[0].id, subjectId: subjectId, term: 'T1', evaluation: 'Devoir', maxScore: 20, score: 25),
      throwsArgumentError,
    );
    await db.saveGrade(studentId: students[0].id, subjectId: subjectId, term: 'T1', evaluation: 'Devoir', maxScore: 20, score: 14.5);
    net.set(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await engine.syncNow();
    expect(server.requests.last.url.path, '/api/grades/sync');
    expect(server.recordsOf(server.requests.length - 1).single['score'], 14.5);
    final grades = await db.gradesFor(classId: classId, subjectId: subjectId, term: 'T1', evaluation: 'Devoir');
    expect(grades[students[0].id]!.state, SyncState.synced);
  });

  test('bootstrap : n’écrase pas une modification locale en attente', () async {
    await db.saveAttendance(student: students[0], date: today, isPresent: false);
    await db.applyBootstrap(bootstrapJson(attendance: [
      {
        'id': 'bbbbbbbb-0000-4000-8000-000000000001',
        'studentId': students[0].id,
        'classId': classId,
        'date': today,
        'status': 'PRESENT',
        'clientUpdatedAt': DateTime.now().toUtc().toIso8601String(),
      },
      {
        'id': 'bbbbbbbb-0000-4000-8000-000000000002',
        'studentId': students[1].id,
        'classId': classId,
        'date': today,
        'status': 'ABSENT',
        'clientUpdatedAt': DateTime.now().toUtc().toIso8601String(),
      },
    ]));
    final entries = await db.attendanceFor(classId, today);
    expect(entries[students[0].id]!.isPresent, isFalse);
    expect(entries[students[0].id]!.state, SyncState.local);
    expect(entries[students[1].id]!.isPresent, isFalse);
    expect(entries[students[1].id]!.state, SyncState.synced);
  });

  test('utilitaires : UUID v4, téléphone RDC, notes', () {
    expect(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$').hasMatch(newUuid()), isTrue);
    expect(normalizeDrcPhone('0970000002'), '+243970000002');
    expect(normalizeDrcPhone('+243 81 000 0003'), '+243810000003');
    expect(normalizeDrcPhone('0123'), isNull);
    expect(parseScore('14,5'), 14.5);
    expect(formatScore(14.5), '14,5');
    expect(formatScore(20), '20');
    expect(students.first.fullName, 'KAHINDO MASIKA Grâce');
  });
}
