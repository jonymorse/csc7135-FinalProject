import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { OculusHandModel } from 'three/addons/webxr/OculusHandModel.js';
import { OculusHandPointerModel } from 'three/addons/webxr/OculusHandPointerModel.js';
import { createText } from 'three/addons/webxr/Text2D.js';

import { World, System, Component, TagComponent, Types } from 'three/addons/libs/ecsy.module.js';

// -------------------------------------------------------------------
// ECS COMPONENTS & SYSTEMS (for exit, reset and connect buttons and pointer-based UI)
// -------------------------------------------------------------------

class Object3D extends Component {}
Object3D.schema = { object: { type: Types.Ref } };

class Button extends Component {}
Button.schema = {
	// Button states: "none", "hovered", "pressed"
	currState: { type: Types.String, default: 'none' },
	prevState: { type: Types.String, default: 'none' },
	action: { type: Types.Ref, default: () => {} }
};

class Intersectable extends TagComponent {}

class HandsInstructionText extends TagComponent {}

class OffsetFromCamera extends Component {}
OffsetFromCamera.schema = {
	x: { type: Types.Number, default: 0 },
	y: { type: Types.Number, default: 0 },
	z: { type: Types.Number, default: 0 }
};

class NeedCalibration extends TagComponent {}

class ButtonSystem extends System {
	execute() {
		this.queries.buttons.results.forEach(entity => {
			const button = entity.getMutableComponent(Button);
			const mesh = entity.getComponent(Object3D).object;
			// Visual feedback: scale button when hovered/pressed.
			if (button.currState === 'none') {
				mesh.scale.set(1, 1, 1);
			} else {
				mesh.scale.set(1.1, 1.1, 1.1);
			}
			// Invoke the button's action when transitioning to pressed.
			if (button.currState === 'pressed' && button.prevState !== 'pressed') {
				button.action();
			}
			button.prevState = button.currState;
			button.currState = 'none';
		});
	}
}
ButtonSystem.queries = { buttons: { components: [Button] } };

class HandRaySystem extends System {
	init(attributes) {
		this.handPointers = attributes.handPointers;
	}
	execute() {
		// Cast a ray from each hand pointer to update button states.
		this.handPointers.forEach(hp => {
			let distance = null;
			let intersectEntity = null;
			this.queries.intersectable.results.forEach(entity => {
				const obj = entity.getComponent(Object3D).object;
				const intersections = hp.intersectObject(obj, false);
				if (intersections && intersections.length > 0) {
					if (distance === null || intersections[0].distance < distance) {
						distance = intersections[0].distance;
						intersectEntity = entity;
					}
				}
			});
			if (distance) {
				hp.setCursor(distance);
				if (intersectEntity.hasComponent(Button)) {
					const btn = intersectEntity.getMutableComponent(Button);
					if (hp.isPinched()) {
						btn.currState = 'pressed';
					} else if (btn.currState !== 'pressed') {
						btn.currState = 'hovered';
					}
				}
			} else {
				hp.setCursor(1.5);
			}
		});
	}
}
HandRaySystem.queries = { intersectable: { components: [Intersectable] } };

class InstructionSystem extends System {
	init(attributes) {
		this.controllers = attributes.controllers;
	}
	execute() {
		let visible = false;
		this.controllers.forEach(controller => {
			if (controller.visible) visible = true;
		});
		this.queries.texts.results.forEach(entity => {
			const obj = entity.getComponent(Object3D).object;
			obj.visible = visible;
		});
	}
}
InstructionSystem.queries = { texts: { components: [HandsInstructionText] } };

class CalibrationSystem extends System {
	init(attributes) {
		this.camera = attributes.camera;
		this.renderer = attributes.renderer;
	}
	execute() {
		this.queries.needCalibration.results.forEach(entity => {
			if (this.renderer.xr.getSession()) {
				const offset = entity.getComponent(OffsetFromCamera);
				const obj = entity.getComponent(Object3D).object;
				const xrCamera = this.renderer.xr.getCamera();
				obj.position.set(
					xrCamera.position.x + offset.x,
					xrCamera.position.y + offset.y,
					xrCamera.position.z + offset.z
				);
				entity.removeComponent(NeedCalibration);
			}
		});
	}
}
CalibrationSystem.queries = { needCalibration: { components: [NeedCalibration] } };

// -------------------------------------------------------------------
// GLOBALS & INITIALIZATION (ECS + Cube Interaction)
// -------------------------------------------------------------------

const world = new World();
const clock = new THREE.Clock();
let camera, scene, renderer;

let cubes = [];      // Stores spawned cubes.
let connections = []; // Stores connection lines.
let grabbing = false; // Indicates if a cube is grabbed by the right hand.
let scaling = { active: false, initialDistance: 0, object: null, initialScale: 1 };

const CubeSize = 0.05; // Size for new cubes.

// Global handles for hands and controllers.
let hand1, hand2;
let controller1, controller2;

// Global variables for connection mode.
let connectionMode = false;
let connectionSelection = [];

init();

function makeButtonMesh(x, y, z, color) {
	const geometry = new THREE.BoxGeometry(x, y, z);
	const material = new THREE.MeshPhongMaterial({ color: color });
	const mesh = new THREE.Mesh(geometry, material);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;
}

function init() {
	// Container and scene setup.
	const container = document.createElement('div');
	document.body.appendChild(container);
	scene = new THREE.Scene();
	scene.background = new THREE.Color(0x444444);

	camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10);
	camera.position.set(0, 1.2, 0.3);
	scene.add(new THREE.HemisphereLight(0xcccccc, 0x999999, 3));

	const light = new THREE.DirectionalLight(0xffffff, 3);
	light.position.set(0, 6, 0);
	light.castShadow = true;
	light.shadow.camera.top = 2;
	light.shadow.camera.bottom = -2;
	light.shadow.camera.right = 2;
	light.shadow.camera.left = -2;
	light.shadow.mapSize.set(4096, 4096);
	scene.add(light);

	renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setAnimationLoop(animate);
	renderer.shadowMap.enabled = true;
	renderer.xr.enabled = true;
	renderer.xr.cameraAutoUpdate = false;
	container.appendChild(renderer.domElement);

	const sessionInit = { requiredFeatures: ['hand-tracking'] };
	document.body.appendChild(VRButton.createButton(renderer, sessionInit));

	// Controllers.
	controller1 = renderer.xr.getController(0);
	scene.add(controller1);
	controller2 = renderer.xr.getController(1);
	scene.add(controller2);

	const controllerModelFactory = new XRControllerModelFactory();

	// Hands – using Oculus hand model and adding a pointer for ECS UI.
	hand1 = renderer.xr.getHand(0);
	hand1.add(new OculusHandModel(hand1));
	const handPointer1 = new OculusHandPointerModel(hand1, controller1);
	hand1.add(handPointer1);
	scene.add(hand1);

	hand2 = renderer.xr.getHand(1);
	hand2.add(new OculusHandModel(hand2));
	const handPointer2 = new OculusHandPointerModel(hand2, controller2);
	hand2.add(handPointer2);
	scene.add(hand2);

	// Attach event listeners for cube spawning and manipulation.
	hand1.addEventListener('pinchstart', onPinchStartLeft);
	hand1.addEventListener('pinchend', onPinchEndLeft);
	hand2.addEventListener('pinchstart', onPinchStartRight);
	hand2.addEventListener('pinchend', onPinchEndRight);

	// Floor.
	const floorGeometry = new THREE.PlaneGeometry(4, 4);
	const floorMaterial = new THREE.MeshPhongMaterial({ color: 0x222222 });
	const floor = new THREE.Mesh(floorGeometry, floorMaterial);
	floor.rotation.x = -Math.PI / 2;
	floor.receiveShadow = true;
	scene.add(floor);

	// Menu – invisible plane anchoring the buttons.
	const menuGeometry = new THREE.PlaneGeometry(0.24, 0.5);
	const menuMaterial = new THREE.MeshPhongMaterial({ opacity: 0, transparent: true });
	const menuMesh = new THREE.Mesh(menuGeometry, menuMaterial);
	menuMesh.position.set(0.4, 1, -1);
	menuMesh.rotation.y = -Math.PI / 12;
	scene.add(menuMesh);

	// Exit Button (red) with text.
	const exitButton = makeButtonMesh(0.2, 0.1, 0.01, 0xff0000);
	const exitButtonText = createText('exit', 0.06);
	exitButton.add(exitButtonText);
	exitButtonText.position.set(0, 0, 0.0051);
	exitButton.position.set(0, -0.18, 0);
	menuMesh.add(exitButton);

	// Reset Button (blue) with text.
	const resetButton = makeButtonMesh(0.2, 0.1, 0.01, 0x355c7d);
	const resetButtonText = createText('reset', 0.06);
	resetButton.add(resetButtonText);
	resetButtonText.position.set(0, 0, 0.0051);
	// Position it above the exit button.
	resetButton.position.set(0, -0.06, 0);
	menuMesh.add(resetButton);

	// Connect Button (green) with text.
	const connectButton = makeButtonMesh(0.2, 0.1, 0.01, 0x00ff00);
	const connectButtonText = createText('connect', 0.06);
	connectButton.add(connectButtonText);
	connectButtonText.position.set(0, 0, 0.0051);
	// Position it above the reset button.
	connectButton.position.set(0, 0.06, 0);
	menuMesh.add(connectButton);

	// Instruction and Exit Texts.
	const instructionText = createText('Pinch to spawn and grab cubes; point and pinch on buttons to reset, exit or connect.', 0.04);
	instructionText.position.set(0, 1.6, -0.6);
	scene.add(instructionText);

	const exitText = createText('Exiting session...', 0.04);
	exitText.position.set(0, 1.5, -0.6);
	exitText.visible = false;
	scene.add(exitText);

	// --------------------------------------------------
	// Setup ECS: register components, systems, and entities.
	// --------------------------------------------------
	world
		.registerComponent(Object3D)
		.registerComponent(Button)
		.registerComponent(Intersectable)
		.registerComponent(HandsInstructionText)
		.registerComponent(OffsetFromCamera)
		.registerComponent(NeedCalibration);

	world
		.registerSystem(InstructionSystem, { controllers: [controller1, controller2] })
		.registerSystem(CalibrationSystem, { renderer: renderer, camera: camera })
		.registerSystem(ButtonSystem)
		.registerSystem(HandRaySystem, { handPointers: [handPointer1, handPointer2] });

	// Menu entity to anchor the menu.
	const menuEntity = world.createEntity();
	menuEntity.addComponent(Intersectable);
	menuEntity.addComponent(OffsetFromCamera, { x: 0.4, y: 0, z: -1 });
	menuEntity.addComponent(NeedCalibration);
	menuEntity.addComponent(Object3D, { object: menuMesh });

	// Exit button entity: its action shows "Exiting" text and ends the XR session.
	const ebEntity = world.createEntity();
	ebEntity.addComponent(Intersectable);
	ebEntity.addComponent(Object3D, { object: exitButton });
	const exitAction = function () {
		exitText.visible = true;
		setTimeout(function () {
			exitText.visible = false;
			renderer.xr.getSession().end();
		}, 2000);
	};
	ebEntity.addComponent(Button, { action: exitAction });

	// Reset button entity: its action removes all cubes and connection lines from the scene.
	const rbEntity = world.createEntity();
	rbEntity.addComponent(Intersectable);
	rbEntity.addComponent(Object3D, { object: resetButton });
	const resetAction = function () {
		cubes.forEach(cube => scene.remove(cube));
		cubes = [];
		connections.forEach(line => scene.remove(line));
		connections = [];
		console.log('Cubes and connections have been removed');
	};
	rbEntity.addComponent(Button, { action: resetAction });

	// Connect button entity: its action enables connection mode.
	const cbEntity = world.createEntity();
	cbEntity.addComponent(Intersectable);
	cbEntity.addComponent(Object3D, { object: connectButton });
	const connectAction = function () {
		connectionMode = true;
		connectionSelection = [];
		console.log('Connection mode enabled. Select two cubes.');
	};
	cbEntity.addComponent(Button, { action: connectAction });

	window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
}

// -------------------------------------------------------------------
// CUBE MANIPULATION HANDLERS (using pinch events)
// -------------------------------------------------------------------

function collideCube(indexTip) {
	// Check if the provided indexTip joint is close enough to any spawned cube.
	const tmpVector1 = new THREE.Vector3();
	const tmpVector2 = new THREE.Vector3();
	for (let i = 0; i < cubes.length; i++) {
		const cube = cubes[i];
		indexTip.getWorldPosition(tmpVector1);
		cube.getWorldPosition(tmpVector2);
		const distance = tmpVector1.distanceTo(tmpVector2);
		if (distance < cube.geometry.boundingSphere.radius * cube.scale.x) {
			return cube;
		}
	}
	return null;
}

function onPinchStartLeft(event) {
	const hand = event.target;
	// If the right hand has already grabbed a cube, try enabling scaling.
	if (grabbing) {
		const indexTip = hand.joints['index-finger-tip'];
		const cube = collideCube(indexTip);
		// Enable scaling if the cube under left hand matches the right hand's grabbed cube.
		if (cube && hand2.userData.selected === cube) {
			scaling.active = true;
			scaling.object = cube;
			scaling.initialScale = cube.scale.x;
			scaling.initialDistance = indexTip.position.distanceTo(hand2.joints['index-finger-tip'].position);
			return;
		}
	}
	// Otherwise, spawn a new cube at the left hand's index-finger tip.
	const geometry = new THREE.BoxGeometry(CubeSize, CubeSize, CubeSize);
	const material = new THREE.MeshStandardMaterial({
		color: 0xffffff,
		roughness: 1.0,
		metalness: 0.0
	});
	const cube = new THREE.Mesh(geometry, material);
	cube.geometry.computeBoundingSphere();
	const indexTip = hand.joints['index-finger-tip'];
	cube.position.copy(indexTip.position);
	cube.quaternion.copy(indexTip.quaternion);
	cubes.push(cube);
	scene.add(cube);
}

function onPinchEndLeft(event) {
	// End scaling when the left hand releases.
	scaling.active = false;
}

function onPinchStartRight(event) {
	const hand = event.target;
	const indexTip = hand.joints['index-finger-tip'];
	const cube = collideCube(indexTip);
	if (cube) {
		if (connectionMode) {
			// In connection mode, add cube to selection if not already selected.
			if (!connectionSelection.includes(cube)) {
				connectionSelection.push(cube);
				// Optionally, highlight the selected cube.
				if (cube.material.emissive) {
					cube.material.emissive.setHex(0x00ff00);
				}
				console.log('Cube selected for connection:', cube);
			}
			// If two cubes are selected, create a connection line.
			if (connectionSelection.length === 2) {
				createConnectionLine(connectionSelection[0], connectionSelection[1]);
				// Reset emissive colors of the selected cubes to their normal state.
				connectionSelection.forEach(c => {
					if (c.material.emissive) {
						c.material.emissive.setHex(0x000000);
					}
				});
				connectionSelection = [];
				connectionMode = false;
			}
		} else {
			// Normal behavior: grab the cube.
			grabbing = true;
			indexTip.attach(cube);
			hand.userData.selected = cube;
			console.log('Cube grabbed:', cube);
		}
	}
}


function onPinchEndRight(event) {
	const hand = event.target;
	if (hand.userData.selected !== undefined) {
		const cube = hand.userData.selected;
		// Detach the cube back into the scene so it remains where dropped.
		scene.attach(cube);
		hand.userData.selected = undefined;
		grabbing = false;
	}
	scaling.active = false;
}

// -------------------------------------------------------------------
// FUNCTION TO CREATE A CONNECTION LINE BETWEEN TWO CUBES
// -------------------------------------------------------------------

function createConnectionLine(cube1, cube2) {
	const geometry = new THREE.BufferGeometry();
	const positions = new Float32Array(6); // Two points × 3 coordinates.
	const pos = new THREE.Vector3();
	cube1.getWorldPosition(pos);
	pos.toArray(positions, 0);
	cube2.getWorldPosition(pos);
	pos.toArray(positions, 3);
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	
	const material = new THREE.LineBasicMaterial({ color: 0xff00ff, linewidth: 2 });
	const line = new THREE.Line(geometry, material);
	// Store references to the connected cubes in the line's userData.
	line.userData.cube1 = cube1;
	line.userData.cube2 = cube2;
	scene.add(line);
	connections.push(line);
	console.log('Connection created between cubes.');
}

// -------------------------------------------------------------------
// ANIMATION LOOP
// -------------------------------------------------------------------

function animate() {
	const delta = clock.getDelta();
	const elapsedTime = clock.elapsedTime;
	
	// Update ECS systems (exit/reset/connect buttons, pointer ray, etc.)
	renderer.xr.updateCamera(camera);
	world.execute(delta, elapsedTime);

	// Update connection lines so they stick to the cubes.
	connections.forEach(line => {
		const cube1 = line.userData.cube1;
		const cube2 = line.userData.cube2;
		if (cube1 && cube2) {
			const positions = line.geometry.attributes.position.array;
			let p1 = new THREE.Vector3();
			let p2 = new THREE.Vector3();
			cube1.getWorldPosition(p1);
			cube2.getWorldPosition(p2);
			positions[0] = p1.x;
			positions[1] = p1.y;
			positions[2] = p1.z;
			positions[3] = p2.x;
			positions[4] = p2.y;
			positions[5] = p2.z;
			line.geometry.attributes.position.needsUpdate = true;
		}
	});

	// If scaling is active, adjust the grabbed cube's scale based on distance between index fingertips.
	if (
		scaling.active &&
		hand1 && hand2 &&
		hand1.joints['index-finger-tip'] && hand2.joints['index-finger-tip']
	) {
		const pos1 = hand1.joints['index-finger-tip'].position;
		const pos2 = hand2.joints['index-finger-tip'].position;
		const currentDistance = pos1.distanceTo(pos2);
		const newScale = scaling.initialScale + currentDistance / scaling.initialDistance - 1;
		if (scaling.object) {
			scaling.object.scale.setScalar(newScale);
		}
	}

	renderer.render(scene, camera);
}
