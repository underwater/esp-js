import {MULTIPLE_EVENTS_DELIMITER, PolimerEventHandler, PolimerHandlerMap} from './stateEventHandlers';
import {connect, sendUpdateToDevTools} from './reduxDevToolsConnector';
import {DisposableBase, EspDecoratorUtil, EventEnvelope, EventObservationMetadata, Guard, ObservationStage, observeEvent, PolimerEventPredicate, Router} from 'esp-js';
import {InputEvent, OutputEvent, OutputEventStreamFactory} from './eventTransformations';
import {logger} from './logger';
import * as Rx from 'rx';
import {Store} from './store';
import {PolimerEvents} from './polimerEvents';
import produce from 'immer';
import {StateHandlerModel} from './stateHandlerModel';
import {StorePostEventProcessor, StorePreEventProcessor} from './eventProcessors';

export interface PolimerModelSetup<TStore extends Store> {
    initialStore: TStore;
    stateHandlerMaps: Map<string, PolimerHandlerMap<any, TStore>>;
    stateHandlerObjects: Map<string, any[]>;
    stateHandlerModels: Map<string, StateHandlerModelMetadata>;
    eventStreamFactories: OutputEventStreamFactory<TStore, any, any>[];
    eventStreamHandlerObjects: any[];
    storePreEventProcessor: StorePreEventProcessor<TStore>;
    storePostEventProcessor: StorePostEventProcessor<TStore>;
}

export interface StateHandlerModelMetadata {
    model: any;
    autoWireUpObservers: boolean;
}

interface EventHandlerMetadata {
    stateName: string;
    observationStage: ObservationStage;
    predicate: PolimerEventPredicate;
    handler: PolimerEventHandler<any, any, any>;
}

interface ModelHandlerMetadata<TStore> {
    stateName: string;
    model: StateHandlerModel<TStore>;
}

export class PolimerModel<TStore extends Store> extends DisposableBase {
    private readonly _eventHandlersByEventName: Map<string, EventHandlerMetadata[]> = new Map();
    private readonly _modelEventHandlersByEventName: Map<string, ModelHandlerMetadata<TStore>[]> = new Map();
    private _store: TStore;
    private _storePreEventProcessor: StorePreEventProcessor<TStore>;
    private _storePostEventProcessor: StorePostEventProcessor<TStore>;
    private readonly _modelId: string;

    constructor(
        private readonly _router: Router,
        private readonly _initialSetup: PolimerModelSetup<TStore>
    ) {
        super();
        Guard.isDefined(_router, 'router must be defined');
        Guard.isDefined(_initialSetup, 'router must be defined');
        Guard.isObject(_initialSetup.initialStore, 'store must be defined and be an object');
        Guard.stringIsNotEmpty(_initialSetup.initialStore.modelId, `Initial store's modelId must not be null or empty`);
        this._modelId = this._initialSetup.initialStore.modelId;
        this._store = this._initialSetup.initialStore;
        if (this._initialSetup.storePreEventProcessor) {
            Guard.isFunction(this._initialSetup.storePreEventProcessor, 'The storePreEventProcessor is not a function');
            this._storePreEventProcessor = this._initialSetup.storePreEventProcessor;
        }
        if (this._initialSetup.storePostEventProcessor) {
            Guard.isFunction(this._initialSetup.storePostEventProcessor, 'The storePostEventProcessor is not a function');
            this._storePostEventProcessor = this._initialSetup.storePostEventProcessor;
        }
    }

    public get modelId() {
        return this._modelId;
    }

    public initialize = () => {
        connect(this._router, this._modelId, this, this._modelId);
        sendUpdateToDevTools('@@INIT', this._store, this._modelId);
        this._wireUpStateHandlerModels();
        this._wireUpStateHandlerObjects();
        this._wireUpStateHandlersMaps();
        this._wireUpEventStreams();
        this._listenToAllEvents();
        this.addDisposable(this._router.observeEventsOn(this._modelId, this));
    };

    preProcess() {
        if (this._storePreEventProcessor) {
            let newStore = this._storePreEventProcessor(this._store);
            // has the store been replaced by the processor?
            if (newStore) {
                this._store = newStore;
            }
        }
    }

    postProcess(eventsProcessed: string[]) {
        if (this._storePostEventProcessor) {
            let newStore = this._storePostEventProcessor(this._store, eventsProcessed);
            // has the store been replaced by the processor?
            if (newStore) {
                this._store = newStore;
            }
        }
    }

    // called by the router when it's finished dispatching an event
    public eventDispatched(eventType: string, stage: ObservationStage) {
        if (stage !== ObservationStage.final) {
            return;
        }
        let handlers = this._modelEventHandlersByEventName.get(eventType);
        if (handlers) {
            handlers.forEach((modelHandlerMetadata: ModelHandlerMetadata<TStore>) => {
                // Given an event processed by the model in question has just finished, we replace the relevant state on the store for this model
                let afterState = modelHandlerMetadata.model.getState();
                let beforeState = this._store[modelHandlerMetadata.stateName];
                logger.verbose(`State [${modelHandlerMetadata.stateName}], eventType [${eventType}]: was processed by a model. State will be replaced. Before and after state logged to console .`, beforeState, afterState);
                this._store[modelHandlerMetadata.stateName] = afterState;
            });
        }
    }

    @observeEvent(PolimerEvents.disposeModel)
    private _onDispose() {
        logger.debug(`Disposing PolimerModel<> ${this._modelId}`);
        this.dispose();
    }

    private _listenToAllEvents() {
        let eventsToObserve = Array.from(this._eventHandlersByEventName.keys());
        if (eventsToObserve.length === 0) {
            return;
        }
        this.addDisposable(
            this._router.getAllEventsObservable(eventsToObserve, ObservationStage.all)
                .filter(eventEnvelope => (eventEnvelope.modelId === this._modelId))
                .subscribe((eventEnvelope: EventEnvelope<any, any>) => {
                    const eventReceivers = this._eventHandlersByEventName.get(eventEnvelope.eventType);
                    const store = this._store;
                    eventReceivers.forEach((handlerMetadata: EventHandlerMetadata) => {
                        if (handlerMetadata.observationStage === eventEnvelope.observationStage) {
                            const beforeState = store[handlerMetadata.stateName];
                            if (!handlerMetadata.predicate || handlerMetadata.predicate(beforeState, eventEnvelope.event, store, eventEnvelope.context)) {
                                logger.verbose(`State [${handlerMetadata.stateName}], eventType [${eventEnvelope.eventType}]: invoking a reducer. Before state logged to console.`, beforeState);
                                const afterState = handlerMetadata.handler(beforeState, eventEnvelope.event, store, eventEnvelope.context);
                                logger.verbose(`State [${handlerMetadata.stateName}], eventType [${eventEnvelope.eventType}]: reducer invoked. After state logged to console.`, afterState);
                                store[handlerMetadata.stateName] = afterState;
                            } else {
                                logger.verbose(`Received "${eventEnvelope.eventType}" for "${handlerMetadata.stateName}" state, skipping as the handlers predicate returned false`, beforeState);
                            }
                        }
                    });
                    sendUpdateToDevTools(eventEnvelope, this._store, this._modelId);
                })
        );
    }

    private _wireUpStateHandlerModels() {
        this._initialSetup.stateHandlerModels.forEach((metadata: StateHandlerModelMetadata, stateName: string) => {
            let events: EventObservationMetadata[] = EspDecoratorUtil.getAllEvents(metadata.model);
            events.forEach((eventObservationMetadata: EventObservationMetadata) => {
                let modelEventHandlers = this._modelEventHandlersByEventName.get(eventObservationMetadata.eventType);
                if (!modelEventHandlers) {
                    modelEventHandlers = [];
                    this._modelEventHandlersByEventName.set(eventObservationMetadata.eventType, modelEventHandlers);
                }
                modelEventHandlers.push({stateName: stateName, model: metadata.model});
            });
        });
    }

    private _wireUpStateHandlerObjects() {
        if (!this._initialSetup.stateHandlerObjects) {
            return;
        }
        this._initialSetup.stateHandlerObjects.forEach((objectsToScanForHandlers: any[], stateName) => {
            objectsToScanForHandlers.forEach(objectToScanForHandlers => {
                // create a new handler map which has the eventType as the key
                // we could just omit the decorator and just use function names, but there can be more than one decorators on a function
                let events: EventObservationMetadata[] = EspDecoratorUtil.getAllEvents(objectToScanForHandlers);
                events.forEach((decoratorMetadata: EventObservationMetadata) => {
                    const handler = objectToScanForHandlers[decoratorMetadata.functionName].bind(objectToScanForHandlers);
                    this._addEventHandlerMetadata(decoratorMetadata.eventType, stateName, <PolimerEventPredicate>decoratorMetadata.predicate, decoratorMetadata.observationStage, handler);
                });
            });
        });
    }

    private _wireUpStateHandlersMaps = () => {
        this._initialSetup.stateHandlerMaps.forEach((handlerMap: PolimerHandlerMap<any, TStore>, stateName) => {
            handlerMap = this._expandMultipleEventsIntoSeparateHandlers(handlerMap);
            Object.keys(handlerMap).forEach((eventType: string) => {
                this._addEventHandlerMetadata(eventType, stateName, null, ObservationStage.normal, handlerMap[eventType]);
            });
        });
    };

    private _addEventHandlerMetadata(eventType: string, stateName: string, predicate: PolimerEventPredicate, observationStage: ObservationStage, handler: PolimerEventHandler<any, any, any>) {
        let eventHandlerMetadataArray = this._eventHandlersByEventName.get(eventType);
        if (!eventHandlerMetadataArray) {
            eventHandlerMetadataArray = [];
            this._eventHandlersByEventName.set(eventType, eventHandlerMetadataArray);
        }
        eventHandlerMetadataArray.push(
            <EventHandlerMetadata>{
                stateName: stateName,
                predicate:  predicate,
                observationStage: observationStage,
                // A note on the produce() overload we use, from https://github.com/mweststrate/immer:
                //
                // Passing a function as the first argument to produce is intended to be used for currying.
                // This means that you get a pre-bound producer that only needs a state to produce the value from.
                // The producer function gets passed in the draft, and any further arguments that were passed to the curried function.
                handler: produce(handler)
        });
    }

    private _wireUpEventStreams = () => {
        // There are 2 APIs for event transformations:
        // 1) Via functions that take a event stream factory, these factories take an eventType and return an `Rx.Observable<InputEvent<>>`
        //    The handlers effectively transform the `InputEvent<>`s to `OutputEvent<>` which get dispatched back into the router
        // 2) Via decorators on class functions.
        //    These are functionally similar to the first method, the difference being then don't take an event stream factory,
        //    Rather then decorate functions on an object instance which will do the event transformation.
        //    This second approach allows for dependency injection as the handling objects are effectively containers for event transformational streams
        //
        // We can normalise these down to a single observable as they are effectively the same:
        // i.e. `InputEvent<>`s to `OutputEvent<>` transformation streams.

        const observables = [];

        // First deal with the first type
        observables.push(
            ...this._initialSetup.eventStreamFactories.map(outputEventStreamFactory => outputEventStreamFactory(this._observeEvent))
        );

        // next with second type
        this._initialSetup.eventStreamHandlerObjects.forEach(objectToScanForObservables => {
            const metadata: EventObservationMetadata[] = EspDecoratorUtil.getAllEvents(objectToScanForObservables);

            // group by the function name as there may be multiple events being observed by 1 function
            let metadataGroupedByFunction: { [functionName: string]: EventObservationMetadata[] } = metadata.reduce(
                (result, m) => {
                    (result[m.functionName] = result[m.functionName] || []).push(m);
                    return result;
                },
                {}
            );
            Object.keys(metadataGroupedByFunction).forEach(functionName => {
                const metadataForFunction: EventObservationMetadata[] = metadataGroupedByFunction[functionName];
                // When using decorators the function may declare multiple decorators,
                // they may use a different observation stage. Given that, we subscribe to the router separately
                // and pump the final observable into our handling function to subscribe to.
                const inputEventStream = Rx.Observable.merge(metadataForFunction.map(m => this._observeEvent(m.eventType, m.observationStage)));
                const outputEventStream = objectToScanForObservables[functionName](inputEventStream);
                observables.push(outputEventStream);
            });
        });

        // now we've normalised them as a single observable and we can kick it off
        this.addDisposable(
            Rx.Observable.merge(...observables)
                .filter(output => output != null)
                .subscribe(
                    (output: OutputEvent<any>) => {
                        if (output.broadcast) {
                            logger.verbose('Received a broadcast event from observable. Dispatching to esp-js router.', output);
                            this._router.broadcastEvent(output.eventType, output.event || {});
                        } else {
                            const targetModelId = output.modelId || this._modelId;
                            logger.verbose(`Received eventType ${output.eventType} for model ${targetModelId}. Dispatching to esp-js router.`, output);
                            this._router.publishEvent(targetModelId, output.eventType, output.event);
                        }
                    },
                    (err) => {
                        logger.error(`Error on observable stream for model ${this.modelId}.`, err);
                    }
                )
        );
    };

    private _observeEvent = (eventType: string | string[], stage: ObservationStage = ObservationStage.final): Rx.Observable<InputEvent<TStore, any>> => {
        return Rx.Observable.create((obs: Rx.Observer<any>) => {
                const events = typeof eventType === 'string' ? [eventType] : eventType;
                const espEventStreamSubscription = this._router
                    .getAllEventsObservable(events, stage)
                    .filter(eventEnvelope => eventEnvelope.modelId === this._modelId)
                    .subscribe(
                        (eventEnvelope: EventEnvelope<any, PolimerModel<TStore>>) => {
                            logger.verbose(`Passing event [${eventEnvelope.eventType}] at stage [${eventEnvelope.observationStage}] for model [${eventEnvelope.modelId}] to eventStream.`);
                            let inputEvent: InputEvent<TStore, any> = this._mapEventEnvelopToInputEvent(eventEnvelope);
                            // Pass the event off to our polimer observable stream.
                            // In theory, these streams must never error.
                            // They need to bake in their own exception handling.
                            // We wrap in a try catch just to stop any exception bubbling to the router
                            try {
                                obs.onNext(inputEvent);
                            } catch (err) {
                                logger.error(`Error caught on event observable stream for event ${eventType}.`, err);
                            }
                        },
                        () => obs.onCompleted()
                    );
                return espEventStreamSubscription;
            }
        );
    };

    private _mapEventEnvelopToInputEvent(eventEnvelope: EventEnvelope<any, PolimerModel<TStore>>): InputEvent<TStore, any> {
        return {
            event: eventEnvelope.event,
            eventType: eventEnvelope.eventType,
            context: eventEnvelope.context,
            store: eventEnvelope.model.getStore()
        };
    }

    /**
     * This method takes handlerMap and normalizes it producing a new handlerMap.
     * Process of normalizing includes:
     *   - split handler that listens on handler of events to two different handlers
     *
     * @param {PolimerHandlerMap<TState, TStore>} handlerMap
     * @returns {PolimerHandlerMap<TState, TStore>}
     */
    private _expandMultipleEventsIntoSeparateHandlers = <TState>(handlerMap: PolimerHandlerMap<TState, TStore>): PolimerHandlerMap<TState, TStore> => {
        return Object.keys(handlerMap).reduce((map, eventType) => {
            if (eventType.indexOf(MULTIPLE_EVENTS_DELIMITER) !== -1) {
                const events = eventType.split(MULTIPLE_EVENTS_DELIMITER);
                events.forEach(event => {
                    map[event] = handlerMap[eventType];
                });
            } else {
                map[eventType] = handlerMap[eventType];
            }

            return map;
        }, {});
    };

    public getStore = (): TStore => {
        return this._store;
    };

    public setStore = (value: TStore) => {
        this._store = value;
    };
}