# CRITIQUE - Observabilidade no nopCommerce

## O que ajudou

1. A separação por camadas ajudou.
Como a estrutura está bem dividida (Presentation -> Services -> Data), foi fácil escolher onde instrumentar sem espalhar spans pelo código.

2. O mecanismo de eventos interno também ajudou.
O IEventPublisher é um ponto natural para perceber o que acontece depois de um evento, como OrderPlacedEvent.

## O que dificultou

1. O checkout tem muitos caminhos e exceções.
Há várias validações e ramificações, e isso aumenta o risco de criar spans com ruído ou de deixar buracos na observabilidade.

2. Risco de expor dados sensíveis.
Sem regras bem definidas, é fácil deixar escapar PII em atributos de span.

## Mudanças arquiteturais que eu faria a seguir

1. Centralizar sanitização no pipeline OTel.
Adicionar um processor de redação no collector (ou no SDK) para ter defesa em profundidade.

2. Instrumentar consumidores de eventos críticos.
Principalmente nos eventos de pedidos, para ganhar visibilidade da latência no pós-checkout.

## Mudança cirúrgica realizada

A mudança mais sensível foi adicionar instrumentação no fluxo de place order dentro de OrderProcessingService e no ponto de entrada CheckoutController.

Porque foi necessária:

- A instrumentação automática de HTTP não mostrava detalhes do pagamento, persistência de pedido e publicação de eventos.

Como o impacto foi minimizado:

- A lógica de negócio não foi alterada.
- Os spans e as métricas foram adicionados só em fronteiras de orquestração.
- Os atributos de observabilidade ficaram técnicos e sem PII.
