/**
 * Testes do divisor 3MF: ZIP, XML, paint_color, extruder por peça,
 * transformações e exportação.
 *
 *   node test/split.js
 */
'use strict';

const Split = require('../src/split/3mf.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  \u2713 ' + name);
  } else {
    failed++;
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

function asBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const MAIN = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources>
    <object id="2" type="model">
      <components>
        <component p:path="/3D/Objects/o.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>
  </build>
</model>`;

function objectModel(paint) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
          <vertex x="1" y="1" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"${paint ? ' paint_color="8"' : ''}/>
          <triangle v1="1" v2="3" v3="2"${paint ? ' paint_color="8"' : ''}/>
          <triangle v1="0" v2="2" v3="3"/>
        </triangles>
      </mesh>
    </object>
  </resources>
</model>`;
}

function fixture(paint) {
  return Split.zipFiles([
    { name: '3D/3dmodel.model', data: MAIN },
    { name: '3D/Objects/o.model', data: objectModel(paint) },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ filament_colour: ['#FFFFFF', '#80FF00'] }) }
  ]);
}

// Modelo multicolor sem paint_color: cada peça tem seu extruder no
// model_settings.config (como no "medalha leão.3mf").
const MAIN_PARTS = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources>
    <object id="10" type="model">
      <components>
        <component p:path="/3D/Objects/parts.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
        <component p:path="/3D/Objects/parts.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 7 0 0"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="10"/>
  </build>
</model>`;

const PARTS_MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
    <object id="2" type="model">
      <mesh>
        <vertices>
          <vertex x="2" y="0" z="0"/>
          <vertex x="3" y="0" z="0"/>
          <vertex x="2" y="1" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
  </resources>
</model>`;

const MODEL_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="10">
    <metadata key="name" value="medalha"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="peça_1"/>
      <metadata key="extruder" value="3"/>
    </part>
    <part id="2" subtype="normal_part">
      <metadata key="name" value="peça_2"/>
      <metadata key="extruder" value="4"/>
    </part>
  </object>
</config>`;

function extruderFixture() {
  return Split.zipFiles([
    { name: '3D/3dmodel.model', data: MAIN_PARTS },
    { name: '3D/Objects/parts.model', data: PARTS_MODEL },
    { name: 'Metadata/model_settings.config', data: MODEL_SETTINGS },
    {
      name: 'Metadata/project_settings.config',
      data: JSON.stringify({ filament_colour: ['#FFFFFF', '#FF80FF', '#FFFF80', '#000000'] })
    }
  ]);
}

async function main() {
  section('3MF: leitura e paint_color');
  const parsed = await Split.parse(asBuffer(fixture(true)), { applyTransforms: true });
  check('abre o 3MF pelo ZIP', parsed.groups.length === 2, String(parsed.groups.length));
  check('triângulos totais', parsed.triangles === 3, String(parsed.triangles));
  check('objeto resolvido via componente', parsed.objects === 1, String(parsed.objects));
  check('pintado "8" vira filamento_2', parsed.groups[1].id === '2' && parsed.groups[1].triangles === 2,
    parsed.groups[1].id + '/' + parsed.groups[1].triangles);
  check('sem pintura herda filamento_1', parsed.groups[0].id === '1' && parsed.groups[0].triangles === 1,
    parsed.groups[0].id + '/' + parsed.groups[0].triangles);
  check('cores dos filamentos', parsed.colors.join(',') === '#FFFFFF,#80FF00', parsed.colors.join(','));
  check('cor do filamento_2', parsed.groups[1].color === '#80FF00', parsed.groups[1].color);

  section('3MF: decodificação do paint_color (Bambu/Orca/Prusa)');
  check('"4" = filamento 1', Split.decodePaintState('4') === 1, String(Split.decodePaintState('4')));
  check('"8" = filamento 2', Split.decodePaintState('8') === 2, String(Split.decodePaintState('8')));
  check('"0C" = filamento 3', Split.decodePaintState('0C') === 3, String(Split.decodePaintState('0C')));
  check('"1C" = filamento 4', Split.decodePaintState('1C') === 4, String(Split.decodePaintState('1C')));
  check('"4C" = filamento 7', Split.decodePaintState('4C') === 7, String(Split.decodePaintState('4C')));
  check('"44043" = dominante 1', Split.decodePaintState('44043') === 1, String(Split.decodePaintState('44043')));
  check('código vazio = 0', Split.decodePaintState('') === 0);

  const prusaModel = objectModel(false).replace(
    '<triangle v1="0" v2="1" v3="2"/>',
    '<triangle v1="0" v2="1" v3="2" slic3rpe:mmu_segmentation="8"/>'
  );
  const prusa = await Split.parse(asBuffer(Split.zipFiles([
    { name: '3D/3dmodel.model', data: MAIN },
    { name: '3D/Objects/o.model', data: prusaModel },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ filament_colour: ['#FFFFFF', '#80FF00'] }) }
  ])), { applyTransforms: false });
  check('mmu_segmentation do PrusaSlicer também separa',
    prusa.groups.length === 2 && prusa.groups[1].id === '2' && prusa.groups[1].triangles === 1,
    prusa.groups.map((group) => group.id + '/' + group.triangles).join(','));

  section('3MF: extruder por peça (medalha leão)');
  const parts = await Split.parse(asBuffer(extruderFixture()), { applyTransforms: true });
  check('duas cores pelo extruder', parts.groups.length === 2, String(parts.groups.length));
  check('filamento_3 com uma peça', parts.groups[0].id === '3' && parts.groups[0].triangles === 1,
    parts.groups[0].id + '/' + parts.groups[0].triangles);
  check('filamento_4 com uma peça', parts.groups[1].id === '4' && parts.groups[1].triangles === 1,
    parts.groups[1].id + '/' + parts.groups[1].triangles);
  check('cor do filamento_3 (índice 2)', parts.groups[0].color === '#FFFF80', parts.groups[0].color);
  check('cor do filamento_4 (índice 3)', parts.groups[1].color === '#000000', parts.groups[1].color);
  check('transformação do componente aplicada', Math.abs(parts.groups[0].positions[0] - 5) < 1e-6,
    String(parts.groups[0].positions[0]));
  check('aviso de cor ausente não aparece', parts.warnings.length === 0, parts.warnings.join('|'));

  section('3MF: transformações');
  check('build + componente aplicados', Math.abs(parsed.groups[1].positions[0] - 12) < 1e-6,
    String(parsed.groups[1].positions[0]));
  check('tamanho após transformação', parsed.size.join(',') === '1,1,0', parsed.size.join(','));
  const raw = await Split.parse(asBuffer(fixture(true)), { applyTransforms: false });
  check('transformações desligadas', Math.abs(raw.groups[1].positions[0]) < 1e-6,
    String(raw.groups[1].positions[0]));

  // A escala do build vale para a translação do componente: 2*2 + 10 = 14.
  // (Na ordem invertida daria 12 e as peças se afastariam do centro.)
  const scaledMain = MAIN.replace(
    'transform="1 0 0 0 1 0 0 0 1 10 0 0"',
    'transform="2 0 0 0 2 0 0 0 2 10 0 0"'
  );
  const scaled = await Split.parse(asBuffer(Split.zipFiles([
    { name: '3D/3dmodel.model', data: scaledMain },
    { name: '3D/Objects/o.model', data: objectModel(true) }
  ])), { applyTransforms: true });
  check('escala do build multiplica a translação do componente',
    Math.abs(scaled.groups[1].positions[0] - 14) < 1e-6, String(scaled.groups[1].positions[0]));
  check('escala do build também vale em Y',
    Math.abs(scaled.groups[1].positions[7] - 2) < 1e-6, String(scaled.groups[1].positions[7]));

  section('3MF: exportação STL/OBJ/PLY');
  const stl = Split.stlBinary(parsed.groups[1]);
  check('STL tem 84 + 50 * triângulos bytes', stl.length === 84 + 50 * 2, String(stl.length));
  const stlView = new DataView(stl.buffer);
  check('STL declara 2 triângulos', stlView.getUint32(80, true) === 2);
  const obj = Split.objText(parsed.groups[1]);
  check('OBJ tem 2 faces', obj.split('\n').filter((line) => line.startsWith('f ')).length === 2);
  check('OBJ declara o grupo', obj.indexOf('o filamento_2') !== -1);
  const ply = Split.plyText(parsed.groups[1]);
  check('PLY tem cabeçalho ASCII', ply.startsWith('ply\nformat ascii 1.0'));
  check('PLY declara 2 faces', ply.indexOf('element face 2') !== -1);

  section('3MF: STL único com partes separadas');
  const single = Split.exportSingleStl(parsed.groups, 'teste.3mf');
  check('STL único tem nome .stl', single.name === 'teste_partes.stl', single.name);
  check('STL único vem em blocos', Array.isArray(single.data) && single.data.length > 0);
  const singleText = single.data.join('');
  const solids = (singleText.match(/^solid /gm) || []).length;
  check('STL único tem um solid por grupo', solids === 2, String(solids));
  check('STL único mantém filamento_1', singleText.indexOf('solid filamento_1') !== -1);
  check('STL único mantém filamento_2', singleText.indexOf('solid filamento_2') !== -1);
  const facets = (singleText.match(/facet normal/g) || []).length;
  check('STL único tem todos os 3 triângulos', facets === 3, String(facets));
  check('STL único é ASCII', singleText.indexOf('endsolid filamento_2') !== -1);

  section('3MF: ZIP de saída');
  const zip = Split.zipFiles(parsed.groups.map((group) => Split.exportGroup(group, 'stl', 'teste.3mf')));
  check('ZIP começa com PK\\x03\\x04', zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 3 && zip[3] === 4);
  const entries = Split.readZipEntries(asBuffer(zip));
  check('ZIP tem os dois STLs', Object.keys(entries).length === 2, Object.keys(entries).join(','));
  check('nome do STL do filamento_2', Object.keys(entries).some((name) => name === 'teste_filamento_2.stl'));

  section('3MF: sem cor e erro');
  const noPaint = await Split.parse(asBuffer(fixture(false)), { applyTransforms: false });
  check('sem pintura/extruder vira um único grupo 0', noPaint.groups.length === 1 && noPaint.groups[0].id === '0');
  check('sem cor mantém 3 triângulos', noPaint.groups[0].triangles === 3);
  check('grupo 0 mantém o nome paint_color_0', noPaint.groups[0].name === 'paint_color_0');
  check('aviso de ausência de cor', noPaint.warnings.some((warning) => warning.indexOf('paint_color') !== -1));
  let rejected = false;
  try {
    await Split.parse(new ArrayBuffer(20), {});
  } catch (error) {
    rejected = true;
  }
  check('arquivo inválido é recusado', rejected);

  console.log('\n' + passed + ' passaram, ' + failed + ' falharam');
  if (failed) {
    console.log(failures.join('\n'));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
