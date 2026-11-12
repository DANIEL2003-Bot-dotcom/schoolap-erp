import 'dart:convert';

import 'package:ecole_mobile/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'helpers.dart';
import 'widget_test.dart' show settle;

var _t = 0;
GradeEntry g(String subject, String term, double score, {double max = 20, String student = 's'}) {
  _t++;
  return GradeEntry(
    id: 'g$_t',
    studentId: student,
    subjectId: subject,
    term: term,
    evaluation: 'Éval $_t',
    maxScore: max,
    score: score,
    isSynced: true,
    createdAt: DateTime.utc(2026, 10, 1).add(Duration(minutes: _t)).toIso8601String(),
  );
}

const names = {'math': 'Mathématiques', 'fr': 'Français'};

void main() {
  group('Moyennes et signaux (mêmes règles que le serveur)', () {
    test('moyenne pondérée par les points', () {
      expect(averagePct([g('math', 'T1', 10, max: 10), g('math', 'T1', 20, max: 40)]), 60);
      expect(averagePct(const []), isNull);
    });

    test('aucun signal pour un élève régulier', () {
      expect(detectSignals([g('math', 'T1', 14), g('math', 'T1', 13), g('math', 'T1', 15)], names), isEmpty);
    });

    test('baisse ≥ 10 points', () {
      final s = detectSignals([g('math', 'T1', 16), g('math', 'T1', 15), g('math', 'T1', 12)], names).single;
      expect(s.signals, ['CHUTE']);
      expect(s.summary, startsWith('Mathématiques : baisse de 18 points (60 % contre 78 % avant)'));
      expect(detectSignals([g('math', 'T1', 16), g('math', 'T1', 15), g('math', 'T1', 13.6)], names), isEmpty);
      expect(detectSignals([g('math', 'T1', 18), g('math', 'T1', 11)], names), isEmpty);
    });

    test('deux échecs de suite et moyenne sous 50 %', () {
      final s = detectSignals([g('fr', 'T2', 9), g('fr', 'T2', 8)], names).single;
      expect(s.signals, ['ECHECS_CONSECUTIFS', 'FAIBLE']);
      expect(s.averagePct, 42.5);
      expect(detectSignals([g('fr', 'T3', 4), g('fr', 'T3', 11)], names).single.signals, ['FAIBLE']);
      expect(detectSignals([g('fr', 'T1', 6)], names), isEmpty);
    });

    test('moyenne générale en baisse d’un trimestre à l’autre', () {
      final grades = [g('math', 'T1', 16), g('fr', 'T1', 16), g('math', 'T1', 16), g('math', 'T2', 13), g('fr', 'T2', 13), g('fr', 'T2', 13)];
      final general = detectSignals(grades, names).firstWhere((s) => s.subjectId == null);
      expect(general.summary, 'Moyenne générale en baisse : 65 % au T2 contre 80 % au T1');
    });

    test('rapport de classe : alerte du serveur rattachée au signal local', () {
      final students = [
        const Student(id: 'a', classId: 'c', matricule: 'M1', lastName: 'Kahindo', middleName: '', firstName: 'Grâce'),
        const Student(id: 'b', classId: 'c', matricule: 'M2', lastName: 'Kambale', middleName: '', firstName: 'Josué'),
      ];
      final grades = [g('math', 'T1', 8, student: 'a'), g('math', 'T1', 7, student: 'a'), g('math', 'T1', 15, student: 'b')];
      final alert = {'id': 'al1', 'studentId': 'a', 'subjectId': 'math', 'status': 'ACKNOWLEDGED', 'term': 'T1', 'signals': ['FAIBLE'], 'summary': 'x'};
      final report = buildClassReport(students, grades, const [Subject(id: 'math', name: 'Mathématiques', defaultMaxScore: 20)], [alert]);
      expect(report.where((r) => r.signals.isNotEmpty).single.student.id, 'a');
      expect(report.first.signals.single.alert?['id'], 'al1');
      expect(report.first.needsFollowUp, isFalse);
      expect(report.first.termAverage('T1'), 37.5);
    });
  });

  group('Stockage local', () {
    test('migration v1 → v2 : la colonne created_at est ajoutée sans perte de cotes', () async {
      sqfliteFfiInit();
      final path = '${(await databaseFactoryFfi.getDatabasesPath())}/migration_${DateTime.now().microsecondsSinceEpoch}.db';
      final v1 = await databaseFactoryFfi.openDatabase(path, options: OpenDatabaseOptions(version: 1, onCreate: (db, _) async {
        await db.execute('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        await db.execute('''CREATE TABLE grades (
          id TEXT PRIMARY KEY, server_id TEXT, student_id TEXT NOT NULL, subject_id TEXT NOT NULL, term TEXT NOT NULL,
          evaluation TEXT NOT NULL, max_score REAL NOT NULL, score REAL NOT NULL, client_updated_at TEXT NOT NULL,
          is_synced INTEGER NOT NULL DEFAULT 0, sync_error TEXT, UNIQUE (student_id, subject_id, term, evaluation))''');
        await db.insert('grades', {'id': 'x', 'student_id': 's', 'subject_id': 'm', 'term': 'T1', 'evaluation': 'Devoir', 'max_score': 20, 'score': 12, 'client_updated_at': '2026-10-01T00:00:00Z'});
      }));
      await v1.close();
      final db = await LocalDb.open(factory: databaseFactoryFfi, path: path);
      final row = (await db.db.query('grades')).single;
      expect(row.containsKey('created_at'), isTrue);
      expect(row['score'], 12);
      await db.close();
    });

    test('bootstrap : alertes conservées, date de saisie gardée, cotes refusées ignorées', () async {
      final db = await openTestDb();
      await db.applyBootstrap({
        ...bootstrapJson(grades: [
          {'id': 'g1', 'studentId': studentIds[0], 'subjectId': subjectId, 'term': 'T1', 'evaluation': 'Devoir', 'maxScore': 20, 'score': 8, 'clientUpdatedAt': '2026-10-02T08:00:00Z', 'createdAt': '2026-10-01T08:00:00Z'},
        ]),
        'alerts': [
          {'id': 'al1', 'studentId': studentIds[0], 'classId': classId, 'subjectId': subjectId, 'status': 'ACTIVE', 'term': 'T1', 'signals': ['FAIBLE'], 'summary': 'Mathématiques : moyenne T1 40 %'},
        ],
      });
      expect((await db.alerts()).single['id'], 'al1');
      final saved = await db.saveGrade(studentId: studentIds[0], subjectId: subjectId, term: 'T1', evaluation: 'Devoir', maxScore: 20, score: 9);
      expect(saved.createdAt, '2026-10-01T08:00:00Z', reason: 'la date de première saisie ne change pas à la correction');
      await db.db.update('grades', {'sync_error': 'Refusé'}, where: 'id = ?', whereArgs: [saved.id]);
      expect(await db.classGrades(classId), isEmpty);
      await db.close();
    });
  });

  testWidgets('onglet Moyennes : élève signalé, pastille, puis « pris en charge »', (tester) async {
    final net = FakeConnectivity(online: true);
    final server = FakeServer();
    final alert = {
      'id': 'al1',
      'studentId': studentIds[1],
      'classId': classId,
      'subjectId': subjectId,
      'status': 'ACTIVE',
      'term': 'T1',
      'signals': ['ECHECS_CONSECUTIFS', 'FAIBLE'],
      'summary': 'Mathématiques : deux échecs de suite (40 % puis 35 %) · moyenne T1 38 % (sous 50 %)',
      'smsStatus': 'SENT',
    };
    final grades = [
      for (final (i, e) in [(8.0, 'Interrogation 1'), (7.0, 'Interrogation 2')].indexed)
        {'id': 'k$i', 'studentId': studentIds[1], 'subjectId': subjectId, 'term': 'T1', 'evaluation': e.$2, 'maxScore': 20, 'score': e.$1, 'clientUpdatedAt': '2026-10-0${i + 1}T08:00:00Z', 'createdAt': '2026-10-0${i + 1}T08:00:00Z'},
      {'id': 'k9', 'studentId': studentIds[0], 'subjectId': subjectId, 'term': 'T1', 'evaluation': 'Interrogation 1', 'maxScore': 20, 'score': 15, 'clientUpdatedAt': '2026-10-01T08:00:00Z', 'createdAt': '2026-10-01T08:00:00Z'},
    ];
    server.override = (http.Request req) {
      if (req.url.path == '/api/teacher/bootstrap') return jsonResponse(200, {...bootstrapJson(grades: grades), 'alerts': [alert]});
      if (req.url.path == '/api/teacher/alerts/al1/acknowledge') {
        final note = (jsonDecode(req.body) as Map)['note'];
        return jsonResponse(200, {'success': true, 'alert': {...alert, 'status': 'ACKNOWLEDGED', 'acknowledgedBy': 'Kambale Jean', 'note': note}});
      }
      if (req.url.path == '/api/teacher/alerts') return jsonResponse(200, {'success': true, 'alerts': [alert]});
      return jsonResponse(200, {'success': true, 'summary': {}, 'results': []});
    };
    late AppController c;
    await tester.runAsync(() async {
      final db = await openTestDb();
      await db.applyBootstrap({...bootstrapJson(grades: grades), 'alerts': [alert]});
      await db.setKv('api_url', 'http://api.test');
      await db.setKv('token', 'jeton');
      await db.setKv('user_name', 'Kambale Jean');
      await db.setKv('school_name', 'Institut Mwanga');
      c = AppController(db: db, connectivity: net, httpClient: server.client);
      await c.init();
    });
    await tester.pumpWidget(EcoleApp(controller: c));
    await settle(tester);

    expect(find.text('Moyennes'), findsOneWidget);
    expect(find.descendant(of: find.byType(Badge), matching: find.text('1')), findsOneWidget);
    await tester.tap(find.text('Moyennes'));
    await settle(tester);

    expect(find.byKey(ValueKey('result-${studentIds[1]}')), findsOneWidget);
    expect(find.byKey(ValueKey('result-${studentIds[0]}')), findsNothing, reason: 'filtre « En difficulté » par défaut');
    expect(find.text('Deux échecs de suite'), findsOneWidget);
    expect(find.text('✉ Tuteur prévenu par SMS'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('ack-al1')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('ack-note')), 'Parent convoqué lundi');
    await tester.tap(find.text('Marquer comme suivi'));
    await settle(tester);
    expect(find.text('✓ Suivi par Kambale Jean — Parent convoqué lundi'), findsOneWidget);
    expect(find.descendant(of: find.byType(Badge), matching: find.text('1')), findsNothing);

    await tester.tap(find.byKey(const Key('filter-all')));
    await settle(tester);
    expect(find.byKey(ValueKey('result-${studentIds[0]}')), findsOneWidget);

    c.sync.dispose();
    await tester.runAsync(() => c.db.close());
  });
}
