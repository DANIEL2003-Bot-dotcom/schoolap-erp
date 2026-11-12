import 'dart:io';

import 'package:ecole_mobile/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'helpers.dart';
import 'widget_test.dart' show settle;

/// Bootstrap où l'école indique le statut « en ordre » de chaque élève (sans montant).
Map<String, dynamic> bootstrapWithFeeStatus() {
  final data = bootstrapJson();
  final cls = (data['classes'] as List).first as Map<String, dynamic>;
  final students = (cls['students'] as List).cast<Map>();
  cls['students'] = [
    <String, dynamic>{...students[0], 'feeOk': false},
    <String, dynamic>{...students[1], 'feeOk': true},
    // 3e élève : pas de champ feeOk (ancienne API) → statut inconnu
    <String, dynamic>{...students[2]},
  ];
  return data;
}

void main() {
  test('statut « en ordre » enregistré hors ligne avec les élèves', () async {
    final db = await openTestDb();
    await db.applyBootstrap(bootstrapWithFeeStatus());
    final students = await db.studentsOfClass(classId);
    expect(students.map((s) => s.feeOk).toList(), [false, true, null]);
    await db.close();
  });

  test('mise à jour de la base locale v2 → v3 : colonne ajoutée, élèves conservés', () async {
    sqfliteFfiInit();
    final dir = await Directory.systemTemp.createTemp('ecole_upgrade_');
    final path = '${dir.path}/v2.db';
    // Base telle qu'installée par la version précédente de l'application (schéma v2).
    final old = await databaseFactoryFfi.openDatabase(path,
        options: OpenDatabaseOptions(
          version: 2,
          onCreate: (db, _) async {
            await db.execute('''CREATE TABLE students (
              id TEXT PRIMARY KEY, class_id TEXT NOT NULL, matricule TEXT NOT NULL,
              last_name TEXT NOT NULL, middle_name TEXT, first_name TEXT NOT NULL, sort_order INTEGER NOT NULL)''');
            await db.execute('CREATE TABLE grades (id TEXT PRIMARY KEY, created_at TEXT)');
            await db.insert('students', {
              'id': studentIds[0], 'class_id': classId, 'matricule': 'MWG-001',
              'last_name': 'Kahindo', 'middle_name': 'Masika', 'first_name': 'Grâce', 'sort_order': 0,
            });
          },
        ));
    await old.close();

    final db = await LocalDb.open(factory: databaseFactoryFfi, path: path);
    final students = await db.studentsOfClass(classId);
    expect(students.single.fullName, 'KAHINDO MASIKA Grâce');
    expect(students.single.feeOk, isNull, reason: 'statut inconnu jusqu’au prochain « Recharger »');
    await db.close();
  });

  testWidgets('appel : pastille « Pas en ordre » et bandeau, rien pour un statut inconnu', (tester) async {
    final net = FakeConnectivity(online: false);
    final server = FakeServer();
    late AppController c;
    await tester.runAsync(() async {
      final db = await openTestDb();
      await db.applyBootstrap(bootstrapWithFeeStatus());
      await db.setKv('api_url', 'http://api.test');
      await db.setKv('token', 'jeton');
      await db.setKv('user_name', 'Kambale Jean');
      await db.setKv('school_name', 'Institut Mwanga');
      c = AppController(db: db, connectivity: net, httpClient: server.client);
      await c.init();
    });
    await tester.pumpWidget(EcoleApp(controller: c));
    await settle(tester);

    expect(find.byKey(ValueKey('fee-ko-${studentIds[0]}')), findsOneWidget);
    expect(find.byKey(ValueKey('fee-ok-${studentIds[1]}')), findsOneWidget);
    expect(find.byKey(ValueKey('fee-ok-${studentIds[2]}')), findsNothing);
    expect(find.byKey(ValueKey('fee-ko-${studentIds[2]}')), findsNothing);
    expect(find.byKey(const Key('fee-note')), findsOneWidget);
    expect(find.textContaining('1 élève n’est pas en ordre'), findsOneWidget);
    // Le statut des frais ne bloque pas l'appel : l'élève peut être pointé normalement.
    await tester.tap(find.byKey(ValueKey('switch-${studentIds[0]}')));
    await settle(tester);
    expect(find.text('Absent · MWG-001', findRichText: true), findsOneWidget);

    c.sync.dispose();
    await tester.runAsync(() => c.db.close());
  });
}
