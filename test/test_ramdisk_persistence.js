/**
 * Manual test for RAM disk persistence
 * This test verifies that RAM disk data is properly saved and restored
 */

const fs = require('fs');
const path = require('path');
const Memory = require('../out/emulator/memory').default;
const { MEMORY_MAIN_LEN, MEMORY_RAMDISK_LEN, RAM_DISK_MAX } = require('../out/emulator/memory');

const TEST_DATA_PATH = path.join(__dirname, 'test_ramdisk_data.bin');

function testRamDiskPersistence() {
  console.log('Testing RAM disk persistence...');

  // Clean up any previous test file
  if (fs.existsSync(TEST_DATA_PATH)) {
    fs.unlinkSync(TEST_DATA_PATH);
  }

  // Test 1: Create a Memory instance and write some data to RAM disk region
  console.log('Test 1: Creating memory and writing test data...');
  const memory1 = new Memory('', TEST_DATA_PATH, false);
  
  // Write test pattern to RAM disk region
  const ramDiskStart = MEMORY_MAIN_LEN;
  const testPattern = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    testPattern[i] = i & 0xFF;
  }
  
  // Write pattern to first 256 bytes of each RAM disk
  for (let diskIdx = 0; diskIdx < RAM_DISK_MAX; diskIdx++) {
    const offset = ramDiskStart + diskIdx * MEMORY_RAMDISK_LEN;
    memory1.ram.set(testPattern, offset);
  }
  
  // Save RAM disk data
  console.log('Test 2: Saving RAM disk data...');
  memory1.SaveRamDiskData();
  
  // Verify file was created
  if (!fs.existsSync(TEST_DATA_PATH)) {
    console.error('FAIL: RAM disk data file was not created');
    return false;
  }
  
  const savedData = fs.readFileSync(TEST_DATA_PATH);
  const expectedSize = MEMORY_RAMDISK_LEN * RAM_DISK_MAX;
  if (savedData.length !== expectedSize) {
    console.error(`FAIL: Saved data size mismatch. Expected ${expectedSize}, got ${savedData.length}`);
    return false;
  }
  
  console.log('Test 3: Loading RAM disk data in a new instance...');
  // Create new memory instance that should load the saved data
  const memory2 = new Memory('', TEST_DATA_PATH, false);
  
  // Verify the data was loaded correctly
  console.log('Test 4: Verifying loaded data...');
  let allMatch = true;
  for (let diskIdx = 0; diskIdx < RAM_DISK_MAX; diskIdx++) {
    const offset = ramDiskStart + diskIdx * MEMORY_RAMDISK_LEN;
    for (let i = 0; i < 256; i++) {
      if (memory2.ram[offset + i] !== testPattern[i]) {
        console.error(`FAIL: Data mismatch at disk ${diskIdx}, byte ${i}. Expected ${testPattern[i]}, got ${memory2.ram[offset + i]}`);
        allMatch = false;
        break;
      }
    }
    if (!allMatch) break;
  }
  
  if (allMatch) {
    console.log('PASS: RAM disk data was correctly saved and restored!');
  }
  
  // Clean up
  if (fs.existsSync(TEST_DATA_PATH)) {
    fs.unlinkSync(TEST_DATA_PATH);
  }
  
  return allMatch;
}

// Run test
const result = testRamDiskPersistence();
process.exit(result ? 0 : 1);
